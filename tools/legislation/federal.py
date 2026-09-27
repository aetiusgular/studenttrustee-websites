"""
Federal bills, roll-call votes, member positions and upcoming floor items.

Sources (all official, none need a key):
  House Clerk EVS XML      https://clerk.house.gov/evs/{year}/roll{NNN}.xml   (positions keyed by bioguide)
  House Clerk EVS index    https://clerk.house.gov/evs/{year}/index.asp
  Senate LIS vote menu     https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{c}_{s}.xml
  Senate LIS vote XML      https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{NNNNN}.xml
  docs.house.gov floor     https://docs.house.gov/floor/  (Bills This Week XML)
  Senate hearings          https://www.senate.gov/general/committee_schedules/hearings.xml
  Senate floor schedule    https://www.senate.gov/legislative/schedule/floor_schedule.xml
  Senate member data       https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml (LIS id -> bioguide)
  GovInfo BILLSTATUS       https://www.govinfo.gov/bulkdata/BILLSTATUS/{congress}/{type}/... (bill details)
  Senate Daily Press       https://www.dailypress.senate.gov/ (next session and scheduled votes, as text)
Fallback when senate.gov refuses the runner: Voteview (UCLA) https://voteview.com/api (not official).

Output under data/legislation/us/:
  members.json                       every current member (from identity.py)
  votes/{congress}-{session}-{chamber}.json   vote index (compact rows)
  votes/{vote_id}.json               one vote with positions
  records/{chamber}-{congress}.json  member x vote matrix ("YNXP…" per member)
  bills/{congress}/index.json, bills/{congress}/{bill_id}.json
  upcoming.json                      floor items, hearings, convene times (next 14 days)
  latest.json                        the 30 most recent votes across both chambers
"""
import os
import re
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

from . import identity, writer
from .common import Http, Manifest, et_to_iso, senate_datetime_to_iso, http_date_to_iso, iso, clock, clock_note, today, EASTERN

HOUSE_INDEX = 'https://clerk.house.gov/evs/%d/index.asp'
HOUSE_ROLL = 'https://clerk.house.gov/evs/%d/roll%03d.xml'
HOUSE_VOTE_PAGE = 'https://clerk.house.gov/Votes/%d%03d'
SENATE_MENU = 'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_%d_%d.xml'
SENATE_VOTE = 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote%d%d/vote_%d_%d_%05d.xml'
SENATE_VOTE_PAGE = 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote%d%d/vote_%d_%d_%05d.htm'
HOUSE_FLOOR = 'https://docs.house.gov/floor/'
HOUSE_FLOOR_XML = 'https://docs.house.gov/floor/Download.aspx?file=/billsthisweek/%s/%s.xml'
SENATE_HEARINGS = 'https://www.senate.gov/general/committee_schedules/hearings.xml'
SENATE_FLOOR = 'https://www.senate.gov/legislative/schedule/floor_schedule.xml'

VOTE_CODES = {'yea': 'Y', 'aye': 'Y', 'guilty': 'Y', 'yes': 'Y',
              'nay': 'N', 'no': 'N', 'not guilty': 'N',
              'present': 'P', 'not voting': 'X'}
BILL_TYPES = {'hr': 'hr', 'h r': 'hr', 'h.r.': 'hr', 's': 's', 's.': 's',
              'hres': 'hres', 'h res': 'hres', 'h.res.': 'hres', 'sres': 'sres', 's res': 'sres', 's.res.': 'sres',
              'hjres': 'hjres', 'h j res': 'hjres', 'h.j.res.': 'hjres', 'sjres': 'sjres', 's j res': 'sjres', 's.j.res.': 'sjres',
              'hconres': 'hconres', 'h con res': 'hconres', 'h.con.res.': 'hconres',
              'sconres': 'sconres', 's con res': 'sconres', 's.con.res.': 'sconres'}
BILL_LABEL = {'hr': 'H.R.', 's': 'S.', 'hres': 'H.Res.', 'sres': 'S.Res.', 'hjres': 'H.J.Res.', 'sjres': 'S.J.Res.',
              'hconres': 'H.Con.Res.', 'sconres': 'S.Con.Res.'}
CONGRESS_GOV_TYPE = {'hr': 'house-bill', 's': 'senate-bill', 'hres': 'house-resolution', 'sres': 'senate-resolution',
                     'hjres': 'house-joint-resolution', 'sjres': 'senate-joint-resolution',
                     'hconres': 'house-concurrent-resolution', 'sconres': 'senate-concurrent-resolution'}
UPCOMING_DAYS = 14
LIMIT = int(os.environ.get('LEGIS_LIMIT', '0') or 0)   # for local test runs: only the last N votes per chamber


def congress_for_year(year):
    return (year - 1789) // 2 + 1


def congress_for_date(d):
    """A Congress begins at noon on 3 January of an odd year; on 1 and 2 January the old one sits."""
    if d.year % 2 == 1 and d.month == 1 and d.day < 3:
        return congress_for_year(d.year - 1)
    return congress_for_year(d.year)


def session_for_year(year):
    return 1 if year % 2 == 1 else 2


def sessions_of_current_congress(today_date=None):
    today_date = today_date or today()
    congress = congress_for_date(today_date)
    first_year = 1789 + (congress - 1) * 2
    years = [y for y in (first_year, first_year + 1) if y <= today_date.year]
    if os.environ.get('LEGIS_YEARS'):   # test hook: restrict to given years
        years = [int(y) for y in os.environ['LEGIS_YEARS'].split(',')]
    return congress, years


def parse_bill_ref(text, congress):
    """'S 2403' / 'H R 9497' / 'H.Con.Res. 89' -> ('us-119-s-2403', 'S. 2403')."""
    if not text:
        return None, None
    t = text.strip().lower().replace(' ', ' ')
    m = re.match(r'^([a-z][a-z .]*?)\s*\.?\s*(\d+)\s*$', t)
    if not m:
        return None, None
    kind = m.group(1).replace('.', ' ').replace('  ', ' ').strip()
    kind = re.sub(r'\s+', ' ', kind)
    key = BILL_TYPES.get(kind) or BILL_TYPES.get(kind.replace(' ', ''))
    if not key:
        return None, None
    num = int(m.group(2))
    return 'us-%d-%s-%d' % (congress, key, num), '%s %d' % (BILL_LABEL[key], num)


def bill_official_url(bill_id):
    _, congress, kind, num = bill_id.split('-')
    return 'https://www.congress.gov/bill/%sth-congress/%s/%s' % (congress, CONGRESS_GOV_TYPE[kind], num)


def _code(label):
    return VOTE_CODES.get((label or '').strip().lower(), 'O')


# ----------------------------------------------------------------------------- House

def parse_house_index(html):
    """Rows from the EVS index page: roll number, date, issue, question, result, title."""
    rows = {}
    for block in re.findall(r'<TR>(.*?)</TR>', html, flags=re.S | re.I):
        m = re.search(r'rollnumber=(\d+)', block)
        if not m:
            continue
        cells = re.findall(r'<TD[^>]*>(.*?)</TD>', block, flags=re.S | re.I)
        clean = [re.sub(r'<[^>]+>', '', c).strip() for c in cells]
        if len(clean) < 6:
            continue
        rows[int(m.group(1))] = {'date': clean[1], 'issue': clean[2], 'question': clean[3],
                                 'result': clean[4], 'title': clean[5]}
    return rows


def parse_house_vote(xml_bytes, year, members):
    root = ET.fromstring(xml_bytes)
    meta = root.find('vote-metadata')
    g = lambda tag: (meta.findtext(tag) or '').strip()
    congress = int(g('congress'))
    session = 1 if g('session').startswith('1') else 2
    roll = int(g('rollcall-num'))
    action_time = meta.find('action-time')
    when = et_to_iso(g('action-date'), action_time.text if action_time is not None else None)
    totals = meta.find('vote-totals/totals-by-vote')
    t = lambda tag: int((totals.findtext(tag) or '0').strip() or 0) if totals is not None else 0
    bill_id, bill_label = parse_bill_ref(g('legis-num'), congress)
    positions = []
    labels = {}
    for rv in root.findall('vote-data/recorded-vote'):
        leg = rv.find('legislator')
        label = (rv.findtext('vote') or '').strip()
        code = _code(label)
        labels.setdefault(code, label)
        bioguide = leg.get('name-id')
        positions.append([bioguide, code])
        if bioguide not in members:
            members[bioguide] = {'id': bioguide, 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-house',
                                 'name': leg.text or bioguide, 'last': leg.get('sort-field') or leg.text,
                                 'party': leg.get('party'), 'state': leg.get('state'), 'district': None,
                                 'ids': {'bioguide': bioguide}, 'urls': {}, 'provisional': True}
    result = g('vote-result')
    passed = result.lower().startswith(('passed', 'agreed', 'adopted', 'confirmed'))
    vote_id = 'us-house-%d-%d-%d' % (congress, session, roll)
    return {
        'id': vote_id, 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-house',
        'congress': congress, 'session': session, 'number': roll,
        'date': when, 'question': g('vote-question'), 'title': g('vote-desc'),
        'vote_type': g('vote-type'), 'result': result, 'passed': passed,
        'tally': {'yes': t('yea-total'), 'no': t('nay-total'), 'present': t('present-total'), 'not_voting': t('not-voting-total')},
        'bill_id': bill_id, 'bill_label': bill_label,
        'labels': labels, 'positions': positions,
        'official_url': HOUSE_VOTE_PAGE % (year, roll),
        'source': {'id': 'us-house-clerk', 'name': 'Clerk of the U.S. House of Representatives', 'url': HOUSE_ROLL % (year, roll)},
    }


def refresh_house(http, manifest, congress, years, members):
    sid = 'us-house-clerk'
    manifest.describe(sid, 'Clerk of the U.S. House, roll-call vote XML', 'https://clerk.house.gov/Votes', 'federal')
    existing = {v['id']: v for v in _reload_existing('house', congress)}
    stale_before = len(http.stale_served)
    votes, kept = [], 0
    for year in years:
        # index.asp lists only the newest rolls (older ones sit on ROLL_300.asp etc.),
        # so take the highest number from it and walk every roll from 1.
        html, _ = http.get_text(HOUSE_INDEX % year, ttl=0)
        index = parse_house_index(html)
        if not index:
            raise RuntimeError('House EVS index for %d had no rows' % year)
        latest = max(index)
        rolls = list(range(1, latest + 1))
        if LIMIT:
            rolls = rolls[-LIMIT:]
        for roll in rolls:
            # Finished votes do not change; re-check the last few for corrections.
            ttl = 6 * 3600 if roll > latest - 5 else 60 * 24 * 3600
            try:
                body, meta = http.get(HOUSE_ROLL % (year, roll), ttl=ttl)
                v = parse_house_vote(body, year, members)
            except Exception as e:  # one bad roll must not sink the run: keep the published copy
                vid = 'us-house-%d-%d-%d' % (congress, session_for_year(year), roll)
                if vid in existing:
                    votes.append(existing[vid]); kept += 1
                print('   house roll %d/%d skipped: %s' % (year, roll, e))
                continue
            v['source_updated_at'] = http_date_to_iso(meta.get('last_modified')) or v['date']
            votes.append(v)
    updated = max((v['source_updated_at'] for v in votes if v.get('source_updated_at')), default=None)
    failed = len(http.stale_served) - stale_before + kept
    if failed:
        manifest.partial(sid, '%d requests failed; earlier copies were kept for them' % failed, source_updated_at=updated)
    else:
        manifest.ok(sid, source_updated_at=updated)
    return votes


# ---------------------------------------------------------------------------- Senate

def parse_senate_menu(xml_bytes):
    root = ET.fromstring(xml_bytes)
    congress = int(root.findtext('congress'))
    session = int(root.findtext('session'))
    rows = []
    for v in root.findall('votes/vote'):
        rows.append({'number': int(v.findtext('vote_number')), 'date': (v.findtext('vote_date') or '').strip(),
                     'issue': (v.findtext('issue') or '').strip(), 'question': ' '.join((v.findtext('question') or '').split()),
                     'result': (v.findtext('result') or '').strip(), 'title': ' '.join((v.findtext('title') or '').split())})
    return congress, session, rows


def parse_senate_vote(xml_bytes, members, lis_index):
    root = ET.fromstring(xml_bytes)
    g = lambda tag: ' '.join((root.findtext(tag) or '').split())
    congress, session, number = int(g('congress')), int(g('session')), int(g('vote_number'))
    doc_type, doc_num = g('document/document_type'), g('document/document_number')
    bill_id, bill_label = parse_bill_ref('%s %s' % (doc_type, doc_num), congress) if doc_type and doc_num else (None, None)
    count = root.find('count')
    c = lambda tag: int((count.findtext(tag) or '0').strip() or 0) if count is not None else 0
    positions, labels = [], {}
    for m in root.findall('members/member'):
        lis = (m.findtext('lis_member_id') or '').strip()
        label = (m.findtext('vote_cast') or '').strip()
        code = _code(label)
        labels.setdefault(code, label)
        bioguide = lis_index.get(lis)
        if not bioguide:
            bioguide = 'lis-' + lis
            members.setdefault(bioguide, {'id': bioguide, 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
                                          'name': '%s %s' % (m.findtext('first_name') or '', m.findtext('last_name') or ''),
                                          'last': m.findtext('last_name'), 'party': m.findtext('party'), 'state': m.findtext('state'),
                                          'district': None, 'ids': {'lis': lis}, 'urls': {}, 'provisional': True})
        positions.append([bioguide, code])
    result = g('vote_result')
    passed = bool(re.search(r'agreed|passed|confirmed|adopted|sustained|guilty', result, re.I)) and not re.search(r'not agreed|rejected|not sustained|not guilty|failed', result, re.I)
    vote_id = 'us-senate-%d-%d-%d' % (congress, session, number)
    return {
        'id': vote_id, 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
        'congress': congress, 'session': session, 'number': number,
        'date': senate_datetime_to_iso(g('vote_date')), 'question': g('vote_question_text') or g('question'),
        'title': g('document/document_short_title') or g('document/document_title') or g('vote_title') or g('vote_document_text'),
        'vote_type': 'majority %s' % g('majority_requirement') if g('majority_requirement') else '',
        'result': result, 'passed': passed,
        'tally': {'yes': c('yeas'), 'no': c('nays'), 'present': c('present'), 'not_voting': c('absent')},
        'bill_id': bill_id, 'bill_label': bill_label,
        'labels': labels, 'positions': positions,
        'official_url': SENATE_VOTE_PAGE % (congress, session, congress, session, number),
        'source': {'id': 'us-senate-lis', 'name': 'U.S. Senate Legislative Information System', 'url': SENATE_VOTE % (congress, session, congress, session, number)},
        'source_updated_at': senate_datetime_to_iso(g('modify_date')),
    }


def refresh_senate(http, manifest, congress, years, members):
    """Senate roll calls from senate.gov. senate.gov sometimes refuses cloud servers (Akamai 403s,
    LibraryOfCongress/api.congress.gov#441). When that happens: votes already published are kept,
    and votes not yet published are filled in from Voteview (UCLA), labelled as such."""
    sid = 'us-senate-lis'
    manifest.describe(sid, 'U.S. Senate roll-call vote XML (LIS)', 'https://www.senate.gov/legislative/votes_new.htm', 'federal')
    lis_index = {m['ids']['lis']: bid for bid, m in members.items() if m.get('ids', {}).get('lis')}
    existing = {v['id']: v for v in _reload_existing('senate', congress)}
    stale_before = len(http.stale_served)
    votes, missing, problems = [], [], []
    for year in years:
        session = session_for_year(year)
        try:
            body, meta = http.get(SENATE_MENU % (congress, session), ttl=0)
            if meta.get('stale'):
                problems.append('vote list for session %d could not be refreshed' % session)
            _, _, rows = parse_senate_menu(body)
        except Exception as e:
            problems.append('vote list for session %d unavailable: %s' % (session, e))
            rows = []
        numbers = sorted(r['number'] for r in rows)
        if LIMIT:
            numbers = numbers[-LIMIT:]
        latest = numbers[-1] if numbers else 0
        for number in numbers:
            vid = 'us-senate-%d-%d-%d' % (congress, session, number)
            ttl = 6 * 3600 if number > latest - 5 else 60 * 24 * 3600
            try:
                body, meta = http.get(SENATE_VOTE % (congress, session, congress, session, number), ttl=ttl)
                v = parse_senate_vote(body, members, lis_index)
            except Exception as e:
                if vid in existing and existing[vid].get('source', {}).get('id') == sid:
                    votes.append(existing[vid])
                else:
                    missing.append((session, number))
                print('   senate vote %s: %s' % (vid, e))
                continue
            v['source_updated_at'] = v.get('source_updated_at') or http_date_to_iso(meta.get('last_modified')) or v['date']
            votes.append(v)
    have = {v['id'] for v in votes}
    missing_ids = {'us-senate-%d-%d-%d' % (congress, ses, num) for ses, num in missing}
    for vid, v in existing.items():      # published earlier and not re-listed tonight: keep
        if vid not in have and vid not in missing_ids and not LIMIT:
            votes.append(v)
            have.add(vid)
    stale = len(http.stale_served) - stale_before
    filled = []
    if problems or missing or stale:
        filled = voteview_senate(http, manifest, congress, years, members, lis_index, have, missing, votes)
        votes += filled
    for vid in missing_ids - {v['id'] for v in votes}:   # Voteview could not fill it either: keep what was published
        if vid in existing:
            votes.append(existing[vid])
    updated = max((v['source_updated_at'] for v in votes if v.get('source_updated_at')), default=None)
    if problems or missing or stale:
        msg = '; '.join(problems + (['%d vote files unavailable' % len(missing)] if missing else []) + (['%d earlier copies used' % stale] if stale else []))
        manifest.partial(sid, msg + ('; %d votes filled in from Voteview' % len(filled) if filled else ''), source_updated_at=updated)
    else:
        manifest.ok(sid, source_updated_at=updated)
        if 'voteview' in manifest.data['sources']:
            manifest.source('voteview').update({'note': 'Not needed on the last run: senate.gov answered every request.', 'last_checked_at': manifest.data['sources'][sid]['last_checked_at']})
    return votes


VOTEVIEW = 'https://voteview.com'
VOTEVIEW_CAST = {'yea': 'Y', 'nay': 'N', 'present': 'P'}     # everything else (not voting, paired, announced) is X


def voteview_senate(http, manifest, congress, years, members, lis_index, have, missing, published):
    """Senate votes senate.gov would not serve tonight, from Voteview's API. Voteview is an academic
    database (UCLA) built from the same official records; it is used only as a fallback. Returns votes
    in the same shape as parse_senate_vote(), with source 'voteview' and the senate.gov page as the
    official record."""
    sid = 'voteview'
    manifest.describe(sid, 'Voteview (UCLA) roll-call database, fallback for Senate votes', VOTEVIEW + '/data', 'federal', official=False)
    first_year = 1789 + (congress - 1) * 2
    known_dates = sorted(v['date'][:10] for v in published if v.get('body') == 'us-senate' and v.get('date'))
    since = known_dates[-1] if known_dates else '%d-01-03' % first_year
    want = set(missing)
    try:
        found, _ = http.get_json(VOTEVIEW + '/api/search', ttl=0,
                                 params={'q': 'congress:%d' % congress, 'chamber': 'Senate', 'startdate': since})
    except Exception as e:
        manifest.error(sid, e)
        print('   voteview search failed: %s' % e)
        return []
    offsets, out = {}, []
    for rc in sorted(found.get('rollcalls') or [], key=lambda r: r.get('rollnumber') or 0, reverse=True):
        year = int((rc.get('date') or '0')[:4] or 0)
        if year not in years:
            continue
        session = session_for_year(year)
        if session in offsets:
            number = rc['rollnumber'] - offsets[session]
            vid = 'us-senate-%d-%d-%d' % (congress, session, number)
            if vid in have and (session, number) not in want:
                continue
        try:
            detail, _ = http.get_json(VOTEVIEW + '/api/download', ttl=24 * 3600, params={'rollcall_id': rc['id']})
            full = (detail.get('rollcalls') or [None])[0]
        except Exception as e:
            print('   voteview %s skipped: %s' % (rc.get('id'), e))
            continue
        if not full or not full.get('clerk_rollnumber'):
            continue
        number = int(full['clerk_rollnumber'])
        offsets[session] = int(full['rollnumber']) - number
        vid = 'us-senate-%d-%d-%d' % (congress, session, number)
        if vid in have and (session, number) not in want:
            continue
        out.append(voteview_vote(full, congress, session, number, members, lis_index))
        have.add(vid)
    if out:
        manifest.ok(sid, note='%d Senate votes filled in because senate.gov could not be reached' % len(out))
    else:
        manifest.source(sid).update({'last_checked_at': manifest.data['sources'].get('us-senate-lis', {}).get('last_checked_at'),
                                     'note': 'Checked; no Senate votes needed filling in.'})
        manifest.source(sid).setdefault('status', 'ok')
    return out


def voteview_vote(rc, congress, session, number, members, lis_index):
    from .common import now_iso
    positions, labels = [], {}
    for m in rc.get('votes') or []:
        label = (m.get('cast_str') or '').strip()
        code = VOTEVIEW_CAST.get(label.lower(), 'X')
        labels.setdefault(code, label)
        bio, lis = m.get('bioguide_id'), m.get('lis_member_id')
        mid = bio if bio in members else (lis_index.get(lis) or ('lis-' + lis if lis else bio))
        positions.append([mid, code])
    tally = {'yes': sum(1 for p in positions if p[1] == 'Y'), 'no': sum(1 for p in positions if p[1] == 'N'),
             'present': sum(1 for p in positions if p[1] == 'P'), 'not_voting': sum(1 for p in positions if p[1] == 'X')}
    question = ' '.join((rc.get('vote_question_text') or rc.get('question') or '').split())
    bill_id, bill_label = bill_from_code(rc.get('bill_number'), congress)
    if not bill_id:
        m = re.search(r'([HS]\.\s?(?:Con\.\s?|J\.\s?)?(?:Res\.\s?)?(?:R\.\s?)?\d+)\s*$', question)
        bill_id, bill_label = parse_bill_ref(m.group(1), congress) if m else (None, None)
    result = ' '.join((rc.get('vote_result') or '').split())
    passed = bool(re.search(r'agreed|passed|confirmed|adopted|sustained|guilty', result, re.I)) and not re.search(r'not agreed|rejected|not sustained|not guilty|failed', result, re.I)
    return {
        'id': 'us-senate-%d-%d-%d' % (congress, session, number), 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
        'congress': congress, 'session': session, 'number': number,
        'date': rc.get('date'), 'question': question,
        'title': ' '.join((rc.get('vote_document_text') or rc.get('vote_title') or rc.get('description') or '').split()),
        'vote_type': '', 'result': result, 'passed': passed, 'tally': tally,
        'bill_id': bill_id, 'bill_label': bill_label, 'labels': labels, 'positions': positions,
        'official_url': SENATE_VOTE_PAGE % (congress, session, congress, session, number),
        'source': {'id': 'voteview', 'name': 'Voteview (UCLA), used because senate.gov could not be reached',
                   'url': '%s/rollcall/%s' % (VOTEVIEW, rc.get('id'))},
        'source_updated_at': None, 'retrieved_at': now_iso(),
    }


def bill_from_code(code, congress):
    """Voteview's bill_number ('HCONRES89', 'S4668', 'PN9991') -> our bill id, or (None, None) for nominations."""
    m = re.match(r'^(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES)(\d+)$', (code or '').upper())
    if not m:
        return None, None
    kind, num = m.group(1).lower(), int(m.group(2))
    return 'us-%d-%s-%d' % (congress, kind, num), '%s %d' % (BILL_LABEL[kind], num)


# -------------------------------------------------------------------------- upcoming

def parse_bills_this_week(xml_bytes):
    root = ET.fromstring(xml_bytes)
    week = root.get('week-date')
    updated = root.get('update-date')
    items = []
    for cat in root.findall('category'):
        ctype = cat.get('type') or ''
        for fi in cat.findall('floor-items/floor-item'):
            if (fi.get('remove-date') or '').strip():
                continue
            legis = ' '.join((fi.findtext('legis-num') or '').split())
            text = ' '.join((fi.findtext('floor-text') or '').split())
            files = [f.get('doc-url') for f in fi.findall('files/file') if f.get('doc-url')]
            items.append({'legis_num': legis, 'text': text, 'category': ctype, 'docs': files,
                          'added': fi.get('add-date'), 'published': fi.get('publish-date')})
    return week, updated, items


def refresh_house_floor(http, manifest, congress):
    sid = 'docs-house-floor'
    manifest.describe(sid, 'House Majority Leader: Bills This Week (docs.house.gov)', HOUSE_FLOOR, 'federal')
    html, _ = http.get_text(HOUSE_FLOOR, ttl=0)
    weeks = sorted(set(re.findall(r'billsthisweek/(\d{8})/\1\.xml', html)))
    if not weeks:
        raise RuntimeError('no Bills This Week file linked from docs.house.gov/floor')
    week = weeks[-1]
    body, meta = http.get(HOUSE_FLOOR_XML % (week, week), ttl=0)
    week_date, updated, items = parse_bills_this_week(body)
    out = []
    monday = datetime.strptime(week_date, '%Y-%m-%d').date() if week_date else datetime.strptime(week, '%Y%m%d').date()
    for it in items:
        bill_id, bill_label = parse_bill_ref(it['legis_num'], congress)
        out.append({
            'id': 'us-house-floor-%s-%s' % (week, re.sub(r'[^a-z0-9]+', '', it['legis_num'].lower()) or len(out)),
            'level': 'federal', 'jurisdiction': 'us', 'body': 'us-house', 'kind': 'floor',
            'date': monday.isoformat(), 'date_precision': 'week',
            'title': ('%s: %s' % (bill_label or it['legis_num'], it['text'])).strip(': '),
            'category': it['category'], 'bill_id': bill_id, 'bill_label': bill_label or it['legis_num'],
            'status': 'scheduled', 'official_url': 'https://docs.house.gov/floor/', 'documents': it['docs'][:3],
            'source': {'id': sid, 'name': 'docs.house.gov Bills This Week', 'url': HOUSE_FLOOR_XML % (week, week)},
            'source_updated_at': _isoish(updated),
        })
    manifest.ok(sid, source_updated_at=_isoish(updated), note='week of %s' % monday.isoformat())
    return out


DAILY_PRESS = 'https://www.dailypress.senate.gov/wp-json/wp/v2/posts'
TIMESTAMP_LINE = re.compile(r'^\d{1,2}:\d{2}\s*[ap]\.?\s?m\.?', re.I)
STOP_LINE = re.compile(r'^(During wrap-up|Wrap[- ]?up|Passed by|Confirmed by|Received|Agreed to|The following|Adopted)', re.I)
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']


def parse_daily_press(posts, today_date):
    """The Senate Daily Press Gallery (a nonpartisan Senate office) logs the floor through the day,
    newest entry first. The adjournment entry says when the Senate reconvenes and which votes are
    scheduled; that is the only published source for upcoming Senate floor votes. Returns one
    advisory item for the next session, or None."""
    import html as htmlmod
    for p in posts:
        text = re.sub(r'<br\s*/?>|</p>|</li>|</div>', '\n', (p.get('content') or {}).get('rendered') or '')
        text = htmlmod.unescape(re.sub(r'<[^>]+>', '', text))
        lines = [' '.join(l.split()) for l in text.split('\n') if l.strip()]
        if not lines or not re.search(r'adjourn|stands? in recess|convene', lines[0], re.I):
            continue
        block = [re.sub(r'^\d{1,2}:\d{2}\s*[ap]\.?\s?m\.?\s*', '', lines[0], flags=re.I)]
        for line in lines[1:]:
            if TIMESTAMP_LINE.match(line) or STOP_LINE.match(line):
                break
            block.append(line)
        note = ' '.join(block)[:900]
        posted = datetime.strptime((p.get('date_gmt') or '')[:10], '%Y-%m-%d').date()
        when, at = None, None
        m = re.search(r'(?:reconvene|convene|until)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?)\s*(?:on\s+)?(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+)?(tomorrow|[a-z]+\s+\d{1,2})?', note, re.I)
        if m:
            at = clock(m.group(1).replace(' ', '') if ':' in m.group(1) else m.group(1).replace(' ', '').replace('a', ':00a').replace('p', ':00p'))
            day = (m.group(2) or '').lower()
            if day == 'tomorrow':
                when = posted + timedelta(days=1)
            elif day:
                mon, dd = day.split()
                if mon in MONTHS:
                    year = posted.year + (1 if MONTHS.index(mon) + 1 < posted.month else 0)
                    when = date(year, MONTHS.index(mon) + 1, int(dd))
        when = when or posted
        if when < today_date:
            return None
        return {
            'id': 'us-senate-floor-%s' % when.isoformat(), 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
            'kind': 'floor', 'date': when.isoformat(), 'time': at, 'tz': 'America/New_York',
            'title': 'Senate floor: next session', 'category': 'Senate floor schedule (Senate Daily Press Gallery)',
            'note': note, 'status': 'scheduled', 'official_url': p.get('link') or 'https://www.dailypress.senate.gov/',
            'source': {'id': 'senate-daily-press', 'name': 'Senate Daily Press Gallery', 'url': p.get('link')},
            'source_updated_at': ((p.get('modified_gmt') or p.get('date_gmt') or '')[:19] + 'Z') if p.get('date_gmt') else None,
        }
    return None


def senate_floor_outlook(http, manifest):
    sid = 'senate-daily-press'
    manifest.describe(sid, 'Senate Daily Press Gallery floor log (next session and scheduled votes)', 'https://www.dailypress.senate.gov/', 'federal')
    posts, _ = http.get_json(DAILY_PRESS, ttl=0, params={'per_page': 3, '_fields': 'id,date_gmt,modified_gmt,link,title,content'})
    item = parse_daily_press(posts, today())
    manifest.ok(sid, source_updated_at=item['source_updated_at'] if item else None,
                note=('next session %s' % item['date']) if item else 'no upcoming session announced in the latest posts')
    return [item] if item else []


def _isoish(value):
    """docs.house.gov timestamps are Eastern without an offset; GovInfo's end in Z (UTC)."""
    if not value:
        return None
    try:
        dt = datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')
        if value.rstrip().endswith('Z'):
            from .common import UTC
            return iso(dt.replace(tzinfo=UTC))
        return iso(dt.replace(tzinfo=EASTERN))
    except ValueError:
        return value


def parse_senate_hearings(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for m in root.findall('meeting'):
        if not (m.findtext('identifier') or '').strip():
            continue
        out.append({'identifier': m.findtext('identifier').strip(), 'committee': ' '.join((m.findtext('committee') or '').split()),
                    'type': (m.findtext('type') or '').strip(), 'date': (m.findtext('date_iso_8601') or '').strip(),
                    'time': (m.findtext('time_iso_8601') or '').strip(), 'room': (m.findtext('room') or '').strip(),
                    'matter': ' '.join((m.findtext('matter') or '').split()), 'cmte_code': (m.findtext('cmte_code') or '').strip(),
                    'last_update': (m.findtext('last_update_iso_8601') or '').strip(), 'video_url': (m.findtext('video_url') or '').strip()})
    return out


def refresh_senate_schedules(http, manifest):
    sid = 'senate-schedules'
    manifest.describe(sid, 'U.S. Senate committee hearings and floor schedule XML', 'https://www.senate.gov/committees/hearings_meetings.htm', 'federal')
    body, meta = http.get(SENATE_HEARINGS, ttl=0)
    hearings = parse_senate_hearings(body)
    out = []
    horizon = (today() + timedelta(days=UPCOMING_DAYS)).isoformat()
    for h in hearings:
        if not h['date'] or h['date'] > horizon or h['date'] < today().isoformat():
            continue
        out.append({
            'id': 'us-senate-hearing-%s' % h['identifier'], 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
            'kind': 'committee', 'date': h['date'], 'time': clock(h['time']), 'time_note': clock_note(h['time']), 'tz': 'America/New_York',
            'title': '%s: %s' % (h['committee'], h['matter']) if h['committee'] else h['matter'],
            'category': h['type'], 'status': 'scheduled', 'location': h['room'] or None,
            'official_url': 'https://www.senate.gov/committees/hearings_meetings.htm',
            'source': {'id': sid, 'name': 'senate.gov committee schedule', 'url': SENATE_HEARINGS},
            'source_updated_at': _senate_update_iso(h['last_update']),
        })
    # floor: next convene time
    try:
        body2, meta2 = http.get(SENATE_FLOOR, ttl=0)
        root = ET.fromstring(body2)
        convenes = []
        for day in root.findall('LegislativeDay'):
            for sd in day.findall('SessionDay'):
                nxt = (sd.findtext('NextConveneDate') or '').strip()
                if nxt:
                    convenes.append(nxt)
        nxt = max(convenes) if convenes else None
        if nxt and nxt[:10] >= today().isoformat():
            out.append({'id': 'us-senate-convene-%s' % nxt[:10], 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
                        'kind': 'floor', 'date': nxt[:10], 'time': clock(nxt[11:16]), 'tz': 'America/New_York',
                        'title': 'Senate convenes', 'status': 'scheduled',
                        'official_url': 'https://www.senate.gov/legislative/floor_activity_pail.htm',
                        'source': {'id': sid, 'name': 'senate.gov floor schedule', 'url': SENATE_FLOOR},
                        'source_updated_at': None})
    except Exception as e:
        print('   senate floor schedule skipped: %s' % e)
    manifest.ok(sid, source_updated_at=max((o['source_updated_at'] for o in out if o.get('source_updated_at')), default=None))
    return out


def _senate_update_iso(value):
    # '2026-09-25T19:37:29.000000Z-04:00' is Eastern local time with a stray Z
    if not value:
        return None
    m = re.match(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', value)
    if not m:
        return None
    return iso(datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=EASTERN))


# ------------------------------------------------------------------ GovInfo bill status

BILLSTATUS = 'https://www.govinfo.gov/bulkdata/BILLSTATUS/%s/%s/BILLSTATUS-%s%s%s.xml'


def _text(el, path):
    return ' '.join((el.findtext(path) or '').split()) or None


def parse_billstatus(xml_bytes):
    """GovInfo BILLSTATUS XML (v3) -> the bill fields the site shows. Public domain; the same data
    Congress.gov shows, published by GPO in bulk with no key."""
    root = ET.fromstring(xml_bytes)
    b = root.find('bill')
    if b is None:
        raise ValueError('no <bill> element')
    sponsors = [{'id': _text(i, 'bioguideId'), 'name': _text(i, 'fullName'), 'party': _text(i, 'party'),
                 'state': _text(i, 'state'), 'district': _text(i, 'district')} for i in b.findall('sponsors/item')]
    cosponsors = b.findall('cosponsors/item')
    summaries = sorted(b.findall('summaries/summary'), key=lambda x: x.findtext('updateDate') or '')
    summary = None
    if summaries:
        import html
        raw = summaries[-1].findtext('text') or ''
        summary = ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', raw)).split()) or None
    actions, seen = [], set()
    for a in b.findall('actions/item'):
        d, t = _text(a, 'actionDate'), _text(a, 'text')
        if not d or not t or (d, t) in seen:
            continue
        seen.add((d, t))
        actions.append({'date': d, 'text': t, 'by': _text(a, 'sourceSystem/name')})
    actions.sort(key=lambda a: a['date'], reverse=True)
    laws = ['%s %s' % (_text(l, 'type') or 'Law', _text(l, 'number')) for l in b.findall('laws/item') if _text(l, 'number')]
    return {
        'title': _text(b, 'title'),
        'introduced': _text(b, 'introducedDate'),
        'sponsors': sponsors,
        'cosponsors': len(cosponsors),
        'cosponsors_original': sum(1 for c in cosponsors if (c.findtext('isOriginalCosponsor') or '').lower() == 'true'),
        'policy_area': _text(b, 'policyArea/name'),
        'subjects': [_text(i, 'name') for i in b.findall('subjects/legislativeSubjects/item')][:8],
        'committees': sorted({_text(i, 'name') for i in b.findall('committees/item') if _text(i, 'name')}),
        'summary': summary,
        'summary_version': _text(summaries[-1], 'actionDesc') if summaries else None,
        'latest_action': {'date': _text(b, 'latestAction/actionDate'), 'text': _text(b, 'latestAction/text')},
        'actions': actions[:25],
        'actions_total': len(actions),
        'laws': laws,
        'source_updated_at': _isoish(_text(b, 'updateDateIncludingText') or _text(b, 'updateDate')),
    }


def enrich_bills(http, manifest, bills):
    """Details for every bill that had a recorded vote, from GovInfo's bulk BILLSTATUS files.
    GPO refreshes the current Congress about every 4 hours; Senate floor actions can take a day or
    two to appear there, which is why vote records stay the source for vote results."""
    sid = 'govinfo-billstatus'
    manifest.describe(sid, 'GovInfo Bill Status (BILLSTATUS) bulk data', 'https://www.govinfo.gov/bulkdata/BILLSTATUS', 'federal')
    manifest.data['sources'].pop('congress-gov-api', None)   # replaced: no key needed any more
    stale_before = len(http.stale_served)
    done, failed, latest = 0, 0, None
    for bid, b in bills.items():
        _, congress, kind, num = bid.split('-')
        url = BILLSTATUS % (congress, kind, congress, kind, num)
        try:
            body, meta = http.get(url, ttl=20 * 3600)
            info = parse_billstatus(body)
        except Exception as e:
            failed += 1
            print('   billstatus %s skipped: %s' % (bid, e))
            continue
        for key in ('title', 'introduced', 'sponsors', 'cosponsors', 'cosponsors_original', 'policy_area', 'subjects',
                    'committees', 'summary', 'summary_version', 'actions', 'actions_total', 'laws'):
            if info.get(key) not in (None, [], ''):
                b[key] = info[key]
        if info['latest_action'].get('date') and info['latest_action']['date'] >= ((b.get('latest_action') or {}).get('date') or ''):
            b['latest_action'] = info['latest_action']
        b['source'] = {'id': sid, 'name': 'GovInfo Bill Status (GPO / Library of Congress)', 'url': url}
        b['source_updated_at'] = info['source_updated_at'] or b.get('source_updated_at')
        latest = max(latest or '', b['source_updated_at'] or '') or latest
        done += 1
    stale = len(http.stale_served) - stale_before
    if failed or stale:
        manifest.partial(sid, '%d bills could not be refreshed' % (failed + stale), source_updated_at=latest, note='%d bills' % done)
    else:
        manifest.ok(sid, source_updated_at=latest, note='%d bills' % done)
    return bills


# ----------------------------------------------------------------------------- output

VOTE_COLUMNS = ['id', 'date', 'body', 'number', 'question', 'title', 'result', 'passed', 'yes', 'no', 'other', 'bill_id', 'bill_label', 'source_updated_at']


def vote_row(v):
    return [v['id'], v['date'], v['body'], v['number'], v['question'], v['title'], v['result'], v['passed'],
            v['tally']['yes'], v['tally']['no'], v['tally']['present'] + v['tally']['not_voting'],
            v.get('bill_id'), v.get('bill_label'), v.get('source_updated_at')]


def write_outputs(members, votes, bills, upcoming, congress, manifest):
    # members
    member_rows = sorted(members.values(), key=lambda m: (m['body'], m['state'], m.get('district') or 0, m.get('last') or ''))
    writer.write_json('us/members.json', {'columns': None, 'members': member_rows, 'congress': congress})
    # vote index shards and per-vote files
    by_shard = {}
    keep = set()
    for v in votes:
        shard = '%d-%d-%s.json' % (v['congress'], v['session'], v['body'].split('-')[1])
        by_shard.setdefault(shard, []).append(v)
        rec = dict(v)
        rec['positions'] = v['positions']
        writer.write_json('us/votes/%s.json' % v['id'], rec)
        keep.add(v['id'] + '.json')
    for shard, vs in by_shard.items():
        vs.sort(key=lambda v: (v['date'] or '', v['number']), reverse=True)
        writer.write_json('us/votes/' + shard, {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in vs]})
        keep.add(shard)
    if not LIMIT:
        writer.remove_stale('us/votes', keep)
    # records: member x vote matrix per chamber
    for chamber in ('house', 'senate'):
        vs = sorted([v for v in votes if v['body'] == 'us-' + chamber], key=lambda v: (v['date'] or '', v['number']))
        ids = [v['id'] for v in vs]
        rows = {}
        for i, v in enumerate(vs):
            for mid, code in v['positions']:
                rows.setdefault(mid, ['-'] * len(vs))[i] = code
        writer.write_json('us/records/%s-%d.json' % (chamber, congress),
                          {'votes': ids, 'members': {k: ''.join(r) for k, r in rows.items()}, 'codes': {'Y': 'yes', 'N': 'no', 'P': 'present', 'X': 'not voting', 'O': 'other', '-': 'not a member for this vote'}})
    # bills
    bill_rows = []
    for bid, b in sorted(bills.items()):
        writer.write_json('us/bills/%d/%s.json' % (congress, bid), b)
        la = b.get('latest_action') or {}
        bill_rows.append([bid, b['label'], b.get('title'), la.get('date'), la.get('text'), b.get('chamber_of_origin'), len(b.get('vote_ids') or []), b.get('source_updated_at')])
    writer.write_json('us/bills/%d/index.json' % congress, {'columns': ['id', 'label', 'title', 'latest_action_date', 'latest_action', 'origin', 'votes', 'source_updated_at'], 'rows': bill_rows})
    # upcoming and latest
    upcoming.sort(key=lambda u: (u['date'], u.get('time') or ''))
    writer.write_json('us/upcoming.json', {'items': upcoming, 'horizon_days': UPCOMING_DAYS})
    latest = sorted(votes, key=lambda v: (v['date'] or '', v['number']), reverse=True)[:30]
    writer.write_json('us/latest.json', {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in latest]})
    # search rows
    search = []
    for m in member_rows:
        search.append(['member', m['id'], m['name'], '%s %s%s%s' % (m.get('party') or '', m['state'], ('-%d' % m['district']) if m.get('district') else '', ' former' if m.get('former') else ''), m['body']])
    for bid, b in bills.items():
        search.append(['bill', bid, '%s %s' % (b['label'], b.get('title') or ''), '', b.get('chamber_of_origin') or 'us'])
    writer.write_json('search/us.json', {'columns': ['type', 'id', 'label', 'meta', 'body'], 'rows': search})
    manifest.count('us_members', len(member_rows), scope=congress)
    manifest.count('us_votes', len(votes), scope=congress)
    manifest.count('us_bills', len(bills), scope=congress)
    manifest.count('us_upcoming', len(upcoming))


def build_bills(votes, congress):
    bills = {}
    for v in sorted(votes, key=lambda v: v['date'] or ''):
        bid = v.get('bill_id')
        if not bid:
            continue
        b = bills.setdefault(bid, {'id': bid, 'level': 'federal', 'jurisdiction': 'us', 'congress': congress,
                                   'label': v['bill_label'], 'title': None, 'vote_ids': [], 'official_url': bill_official_url(bid),
                                   'chamber_of_origin': 'us-house' if bid.split('-')[2].startswith('h') else 'us-senate',
                                   'source': {'id': 'vote-records', 'name': 'Derived from the roll-call records above'},
                                   'source_updated_at': None})
        b['vote_ids'].append(v['id'])
        if v.get('title') and (not b['title'] or len(v['title']) > len(b['title'])):
            b['title'] = v['title']
        b['latest_action'] = {'date': (v['date'] or '')[:10], 'text': '%s: %s (%s)' % (('House' if v['body'] == 'us-house' else 'Senate'), v['question'], v['result'])}
        b['source_updated_at'] = max(b['source_updated_at'] or '', v.get('source_updated_at') or '') or None
    return bills


def main(argv=None):
    http = Http()
    manifest = Manifest()
    congress, years = sessions_of_current_congress()
    print('   congress %d, years %s%s' % (congress, years, ' (LEGIS_LIMIT=%d)' % LIMIT if LIMIT else ''))
    members = identity.load_members(http, manifest)
    added = identity.apply_senate_roster(http, manifest, members)
    if added:
        print('   %d senators added from senate.gov member data' % added)
    votes = []
    for name, fn in (('house', refresh_house), ('senate', refresh_senate)):
        try:
            got = fn(http, manifest, congress, years, members)
            print('   %s: %d votes' % (name, len(got)))
            votes += got
        except Exception as e:
            sid = 'us-house-clerk' if name == 'house' else 'us-senate-lis'
            manifest.error(sid, e)
            print('   %s failed: %s' % (name, e))
            # keep what is already on disk for that chamber
            votes += _reload_existing(name, congress)
    named = identity.resolve_departed(http, manifest, members, votes)
    if named:
        print('   %d former members named from the historical file' % named)
    bills = build_bills(votes, congress)
    bills = enrich_bills(http, manifest, bills)
    upcoming = []
    for fn, sid in ((lambda: refresh_house_floor(http, manifest, congress), 'docs-house-floor'),
                    (lambda: refresh_senate_schedules(http, manifest), 'senate-schedules'),
                    (lambda: senate_floor_outlook(http, manifest), 'senate-daily-press')):
        try:
            upcoming += fn()
        except Exception as e:
            manifest.error(sid, e)
            print('   %s failed: %s' % (sid, e))
    press_days = {u['date'] for u in upcoming if u['id'].startswith('us-senate-floor-')}
    upcoming = [u for u in upcoming if not (u['id'].startswith('us-senate-convene-') and u['date'] in press_days)]
    write_outputs(members, votes, bills, upcoming, congress, manifest)
    manifest.save()
    print('   http calls: %d' % http.calls)


def _reload_existing(chamber, congress):
    out = []
    for session in (1, 2):
        idx = writer.read_json('us/votes/%d-%d-%s.json' % (congress, session, chamber))
        if not idx:
            continue
        for row in idx['rows']:
            v = writer.read_json('us/votes/%s.json' % row[0])
            if v:
                out.append(v)
    return out


if __name__ == '__main__':
    main()
