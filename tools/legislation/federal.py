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
Optional, with CONGRESS_API_KEY (free, api.congress.gov): bill titles, sponsors,
latest actions and summaries for every bill that had a recorded vote.

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
from .common import Http, Manifest, et_to_iso, senate_datetime_to_iso, http_date_to_iso, now_iso, iso, EASTERN, UTC

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
CONGRESS_API = 'https://api.congress.gov/v3'

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


def session_for_year(year):
    return 1 if year % 2 == 1 else 2


def sessions_of_current_congress(today=None):
    today = today or date.today()
    congress = congress_for_year(today.year)
    first_year = 1789 + (congress - 1) * 2
    years = [y for y in (first_year, first_year + 1) if y <= today.year]
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
    votes = []
    for year in years:
        html, _ = http.get_text(HOUSE_INDEX % year, ttl=0)
        index = parse_house_index(html)
        if not index:
            raise RuntimeError('House EVS index for %d had no rows' % year)
        rolls = sorted(index)
        if LIMIT:
            rolls = rolls[-LIMIT:]
        latest = rolls[-1]
        for roll in rolls:
            # Finished votes do not change; re-check the last few for corrections.
            ttl = 6 * 3600 if roll > latest - 5 else 60 * 24 * 3600
            try:
                body, meta = http.get(HOUSE_ROLL % (year, roll), ttl=ttl)
                v = parse_house_vote(body, year, members)
            except Exception as e:  # one bad roll must not sink the run
                print('   house roll %d/%d skipped: %s' % (year, roll, e))
                continue
            v['source_updated_at'] = http_date_to_iso(meta.get('last_modified')) or v['date']
            v['checked_at'] = meta.get('fetched_at') or now_iso()
            votes.append(v)
    manifest.ok(sid, source_updated_at=max((v['source_updated_at'] for v in votes), default=None))
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
    sid = 'us-senate-lis'
    manifest.describe(sid, 'U.S. Senate roll-call vote XML (LIS)', 'https://www.senate.gov/legislative/votes_new.htm', 'federal')
    lis_index = {m['ids']['lis']: bid for bid, m in members.items() if m.get('ids', {}).get('lis')}
    votes = []
    for year in years:
        session = session_for_year(year)
        body, _ = http.get(SENATE_MENU % (congress, session), ttl=0)
        _, _, rows = parse_senate_menu(body)
        numbers = sorted(r['number'] for r in rows)
        if LIMIT:
            numbers = numbers[-LIMIT:]
        latest = numbers[-1] if numbers else 0
        for number in numbers:
            ttl = 6 * 3600 if number > latest - 5 else 60 * 24 * 3600
            try:
                body, meta = http.get(SENATE_VOTE % (congress, session, congress, session, number), ttl=ttl)
                v = parse_senate_vote(body, members, lis_index)
            except Exception as e:
                print('   senate vote %d-%d-%d skipped: %s' % (congress, session, number, e))
                continue
            v['source_updated_at'] = v.get('source_updated_at') or http_date_to_iso(meta.get('last_modified')) or v['date']
            v['checked_at'] = meta.get('fetched_at') or now_iso()
            votes.append(v)
    manifest.ok(sid, source_updated_at=max((v['source_updated_at'] for v in votes if v.get('source_updated_at')), default=None))
    return votes


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
            'source_updated_at': _isoish(updated), 'checked_at': meta.get('fetched_at') or now_iso(),
        })
    manifest.ok(sid, source_updated_at=_isoish(updated), note='week of %s' % monday.isoformat())
    return out


def _isoish(value):
    """docs.house.gov timestamps are Eastern without offset."""
    if not value:
        return None
    try:
        dt = datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')
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
    horizon = (date.today() + timedelta(days=UPCOMING_DAYS)).isoformat()
    for h in hearings:
        if not h['date'] or h['date'] > horizon or h['date'] < date.today().isoformat():
            continue
        out.append({
            'id': 'us-senate-hearing-%s' % h['identifier'], 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
            'kind': 'committee', 'date': h['date'], 'time': h['time'] or None, 'tz': 'America/New_York',
            'title': '%s: %s' % (h['committee'], h['matter']) if h['committee'] else h['matter'],
            'category': h['type'], 'status': 'scheduled', 'location': h['room'] or None,
            'official_url': 'https://www.senate.gov/committees/hearings_meetings.htm',
            'source': {'id': sid, 'name': 'senate.gov committee schedule', 'url': SENATE_HEARINGS},
            'source_updated_at': _senate_update_iso(h['last_update']), 'checked_at': meta.get('fetched_at') or now_iso(),
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
        if nxt and nxt[:10] >= date.today().isoformat():
            out.append({'id': 'us-senate-convene-%s' % nxt[:10], 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
                        'kind': 'floor', 'date': nxt[:10], 'time': nxt[11:16], 'tz': 'America/New_York',
                        'title': 'Senate convenes', 'status': 'scheduled',
                        'official_url': 'https://www.senate.gov/legislative/floor_activity_pail.htm',
                        'source': {'id': sid, 'name': 'senate.gov floor schedule', 'url': SENATE_FLOOR},
                        'source_updated_at': None, 'checked_at': meta2.get('fetched_at') or now_iso()})
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


# ------------------------------------------------------------------------ Congress.gov

def enrich_bills(http, manifest, bills, key):
    """Titles, sponsors, latest actions and summaries from api.congress.gov (needs a free key)."""
    sid = 'congress-gov-api'
    manifest.describe(sid, 'Congress.gov API (Library of Congress)', 'https://api.congress.gov/', 'federal')
    if not key:
        manifest.source(sid).update({'status': 'not_configured', 'note': 'Set CONGRESS_API_KEY in the repository secrets for full bill details.'})
        return bills
    latest = None
    done = 0
    for bid, b in bills.items():
        _, congress, kind, num = bid.split('-')
        url = '%s/bill/%s/%s/%s' % (CONGRESS_API, congress, kind, num)
        try:
            data, meta = http.get_json(url, ttl=24 * 3600, params={'format': 'json', 'api_key': key})
        except Exception as e:
            print('   congress.gov %s skipped: %s' % (bid, e))
            continue
        bill = data.get('bill') or {}
        b['title'] = bill.get('title') or b.get('title')
        b['introduced'] = bill.get('introducedDate')
        la = bill.get('latestAction') or {}
        b['latest_action'] = {'date': la.get('actionDate'), 'text': la.get('text')} if la else b.get('latest_action')
        b['policy_area'] = (bill.get('policyArea') or {}).get('name')
        b['sponsors'] = [{'id': s.get('bioguideId'), 'name': s.get('fullName'), 'party': s.get('party'), 'state': s.get('state'), 'district': s.get('district')}
                         for s in bill.get('sponsors') or []]
        b['source_updated_at'] = _isoish(bill.get('updateDateIncludingText') or bill.get('updateDate')) or b.get('source_updated_at')
        b['source'] = {'id': sid, 'name': 'Congress.gov API', 'url': url.replace(CONGRESS_API, 'https://api.congress.gov/v3')}
        latest = max(latest or '', b['source_updated_at'] or '')
        if (bill.get('summaries') or {}).get('count'):
            try:
                sdata, _ = http.get_json(url + '/summaries', ttl=24 * 3600, params={'format': 'json', 'api_key': key})
                sums = sdata.get('summaries') or []
                if sums:
                    s = sorted(sums, key=lambda x: x.get('updateDate') or '')[-1]
                    b['summary'] = re.sub(r'<[^>]+>', '', s.get('text') or '').strip()
                    b['summary_version'] = s.get('actionDesc')
            except Exception as e:
                print('   congress.gov summaries %s skipped: %s' % (bid, e))
        done += 1
    manifest.ok(sid, source_updated_at=latest or None, note='%d bills enriched' % done)
    return bills


# ----------------------------------------------------------------------------- output

VOTE_COLUMNS = ['id', 'date', 'body', 'number', 'question', 'title', 'result', 'passed', 'yes', 'no', 'other', 'bill_id', 'bill_label', 'source_updated_at']


def vote_row(v):
    return [v['id'], v['date'], v['body'], v['number'], v['question'], v['title'], v['result'], v['passed'],
            v['tally']['yes'], v['tally']['no'], v['tally']['present'] + v['tally']['not_voting'],
            v.get('bill_id'), v.get('bill_label'), v.get('source_updated_at')]


def write_outputs(members, votes, bills, upcoming, congress, manifest):
    checked = now_iso()
    # members
    member_rows = sorted(members.values(), key=lambda m: (m['body'], m['state'], m.get('district') or 0, m.get('last') or ''))
    writer.write_json('us/members.json', {'columns': None, 'members': member_rows, 'checked_at': checked, 'congress': congress})
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
        writer.write_json('us/votes/' + shard, {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in vs], 'checked_at': checked})
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
                          {'votes': ids, 'members': {k: ''.join(r) for k, r in rows.items()}, 'codes': {'Y': 'yes', 'N': 'no', 'P': 'present', 'X': 'not voting', 'O': 'other', '-': 'not a member for this vote'}, 'checked_at': checked})
    # bills
    bill_rows = []
    for bid, b in sorted(bills.items()):
        writer.write_json('us/bills/%d/%s.json' % (congress, bid), b)
        la = b.get('latest_action') or {}
        bill_rows.append([bid, b['label'], b.get('title'), la.get('date'), la.get('text'), b.get('chamber_of_origin'), len(b.get('vote_ids') or []), b.get('source_updated_at')])
    writer.write_json('us/bills/%d/index.json' % congress, {'columns': ['id', 'label', 'title', 'latest_action_date', 'latest_action', 'origin', 'votes', 'source_updated_at'], 'rows': bill_rows, 'checked_at': checked})
    # upcoming and latest
    upcoming.sort(key=lambda u: (u['date'], u.get('time') or ''))
    writer.write_json('us/upcoming.json', {'items': upcoming, 'checked_at': checked, 'horizon_days': UPCOMING_DAYS})
    latest = sorted(votes, key=lambda v: (v['date'] or '', v['number']), reverse=True)[:30]
    writer.write_json('us/latest.json', {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in latest], 'checked_at': checked})
    # search rows
    search = []
    for m in member_rows:
        search.append(['member', m['id'], m['name'], '%s %s%s' % (m.get('party') or '', m['state'], ('-%d' % m['district']) if m.get('district') else ''), m['body']])
    for bid, b in bills.items():
        search.append(['bill', bid, '%s %s' % (b['label'], b.get('title') or ''), '', b.get('chamber_of_origin') or 'us'])
    writer.write_json('search/us.json', {'columns': ['type', 'id', 'label', 'meta', 'body'], 'rows': search, 'checked_at': checked})
    manifest.count('us_members', len(member_rows))
    manifest.count('us_votes', len(votes))
    manifest.count('us_bills', len(bills))
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
                                   'source_updated_at': None, 'checked_at': now_iso()})
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
    bills = build_bills(votes, congress)
    bills = enrich_bills(http, manifest, bills, os.environ.get('CONGRESS_API_KEY', '').strip())
    upcoming = []
    for fn, sid in ((lambda: refresh_house_floor(http, manifest, congress), 'docs-house-floor'), (lambda: refresh_senate_schedules(http, manifest), 'senate-schedules')):
        try:
            upcoming += fn()
        except Exception as e:
            manifest.error(sid, e)
            print('   %s failed: %s' % (sid, e))
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
