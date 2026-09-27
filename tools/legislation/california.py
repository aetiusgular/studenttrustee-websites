"""
California Legislature: bills, floor and committee votes with each
legislator's position, legislators, and the daily file (what is scheduled).

Source (official): the Legislature's nightly "pubinfo" database dump,
https://downloads.leginfo.legislature.ca.gov/ (pubinfo_daily_{Day}.zip, about
1.1 GB, written at ~21:20 Pacific). There is no JSON API, and the LegInfo web
site disallows crawlers, so the dump is the only right way in. Each table is
a tab-separated .dat file with backtick-quoted strings and NULL for nulls;
column lists come from pubinfo_load.zip/capublic.sql and are pinned below.

Output under data/legislation/us-ca/:
  members.json                          current Assembly and Senate members
  votes/{session}-{house}-{year}.json   vote index shards (compact rows)
  votes/{session}/{bill_id}.json        every vote on one bill, with positions
  records/{house}-{session}.json        member x vote matrix
  bills/{session}/index.json            every bill of the session (compact rows)
  bills/{session}/{type}-{NN}.json      bill details, sharded by type and hundred
  upcoming.json                         daily file items and committee hearings
  latest.json                           the 30 most recent votes
"""
import os
import re
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import writer
from .common import Http, Manifest, iso, PACIFIC, slugify

BASE = 'https://downloads.leginfo.legislature.ca.gov/'
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
UPCOMING_DAYS = 45      # interim hearings are noticed weeks ahead
LIMIT = int(os.environ.get('LEGIS_LIMIT', '0') or 0)

COLUMNS = {
    'BILL_TBL': ['bill_id', 'session_year', 'session_num', 'measure_type', 'measure_num', 'measure_state', 'chapter_year', 'chapter_type', 'chapter_session_num', 'chapter_num', 'latest_bill_version_id', 'active_flg', 'trans_uid', 'trans_update', 'current_location', 'current_secondary_loc', 'current_house', 'current_status', 'days_31st_in_print'],
    'BILL_VERSION_TBL': ['bill_version_id', 'bill_id', 'version_num', 'bill_version_action_date', 'bill_version_action', 'request_num', 'subject', 'vote_required', 'appropriation', 'fiscal_committee', 'local_program', 'substantive_changes', 'urgency', 'taxlevy', 'bill_xml', 'active_flg', 'trans_uid', 'trans_update'],
    'BILL_HISTORY_TBL': ['bill_id', 'bill_history_id', 'action_date', 'action', 'trans_uid', 'trans_update_dt', 'action_sequence', 'action_code', 'action_status', 'primary_location', 'secondary_location', 'ternary_location', 'end_status'],
    'BILL_SUMMARY_VOTE_TBL': ['bill_id', 'location_code', 'vote_date_time', 'vote_date_seq', 'motion_id', 'ayes', 'noes', 'abstain', 'vote_result', 'trans_uid', 'trans_update', 'file_item_num', 'file_location', 'display_lines', 'session_date'],
    'BILL_DETAIL_VOTE_TBL': ['bill_id', 'location_code', 'legislator_name', 'vote_date_time', 'vote_date_seq', 'vote_code', 'motion_id', 'trans_uid', 'trans_update', 'member_order', 'session_date', 'speaker'],
    'BILL_MOTION_TBL': ['motion_id', 'motion_text', 'trans_uid', 'trans_update'],
    'LEGISLATOR_TBL': ['district', 'session_year', 'legislator_name', 'house_type', 'author_name', 'first_name', 'last_name', 'middle_initial', 'name_suffix', 'name_title', 'web_name_title', 'party', 'active_flg', 'trans_uid', 'trans_update', 'active_legislator'],
    'LOCATION_CODE_TBL': ['session_year', 'location_code', 'location_type', 'consent_calendar_code', 'description', 'long_description', 'active_flg', 'trans_uid', 'trans_update', 'inactive_file_flg'],
    'DAILY_FILE_TBL': ['bill_id', 'location_code', 'consent_calendar_code', 'file_location', 'publication_date', 'floor_manager', 'trans_uid', 'trans_update_date', 'session_num', 'status'],
    'COMMITTEE_HEARING_TBL': ['bill_id', 'committee_type', 'committee_nr', 'hearing_date', 'location_code', 'trans_uid', 'trans_update_date'],
    'COMMITTEE_AGENDA_TBL': ['committee_code', 'committee_desc', 'agenda_date', 'agenda_time', 'line1', 'line2', 'line3', 'building_type', 'room_num'],
    'BILL_VERSION_AUTHORS_TBL': ['bill_version_id', 'type', 'house', 'name', 'contribution', 'committee_members', 'active_flg', 'trans_uid', 'trans_update', 'primary_author_flg'],
}
# pubinfo records AYE / NOE / ABS; LegInfo displays ABS as "No Vote Recorded" (absent, abstaining or not voting)
VOTE_CODES = {'AYE': 'Y', 'YES': 'Y', 'NOE': 'N', 'NO': 'N', 'ABS': 'X', 'ABSTAIN': 'X', 'NVR': 'X', 'NV': 'X'}
CODE_LABELS = {'Y': 'aye', 'N': 'no', 'X': 'no vote recorded', 'O': 'other', '-': 'not on this roll'}
MEASURE_LABEL = {'AB': 'AB', 'SB': 'SB', 'ACA': 'ACA', 'SCA': 'SCA', 'ACR': 'ACR', 'SCR': 'SCR', 'AJR': 'AJR', 'SJR': 'SJR', 'HR': 'HR', 'SR': 'SR', 'ABX1': 'ABX1', 'SBX1': 'SBX1'}


def current_session_year(today=None):
    today = today or date.today()
    y = today.year if today.year % 2 == 1 else today.year - 1
    # sessions start the first Monday in December of the even year before; from December, the next session has begun
    if today.month == 12 and today.year % 2 == 0:
        y = today.year + 1
    return '%d%d' % (y, y + 1)


def parse_dat(data, columns):
    """Rows of a pubinfo .dat file as dicts. Strings are backtick-quoted, NULL is None."""
    text = data.decode('utf-8', 'replace') if isinstance(data, bytes) else data
    rows = []
    pending = ''
    for line in text.split('\n'):
        if not line.strip() and not pending:
            continue
        line = pending + line if pending else line
        parts = line.rstrip('\r').split('\t')
        if len(parts) < len(columns):
            pending = line + '\n'      # a quoted value contained a newline
            continue
        pending = ''
        vals = []
        for p in parts[:len(columns)]:
            if p == 'NULL':
                vals.append(None)
            elif len(p) >= 2 and p[0] == '`' and p[-1] == '`':
                vals.append(p[1:-1])
            else:
                vals.append(p)
        rows.append(dict(zip(columns, vals)))
    return rows


def pick_latest_dump(index_html):
    """(url, listed_datetime) of the newest pubinfo_daily_*.zip in the directory listing."""
    best = None
    for m in re.finditer(r'href="(pubinfo_daily_(%s)\.zip)"[^\n]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})' % '|'.join(DAYS), index_html):
        stamp = m.group(3)
        if not best or stamp > best[1]:
            best = (BASE + m.group(1), stamp)
    return best


def download(http, url, dest):
    """Stream a large file to disk; returns the response's Last-Modified."""
    r = http.session.get(url, stream=True, timeout=600)
    r.raise_for_status()
    with open(dest, 'wb') as fh:
        for chunk in r.iter_content(chunk_size=1 << 20):
            fh.write(chunk)
    return r.headers.get('Last-Modified')


def read_table(zf, name):
    fname = name + '.dat'
    if fname not in zf.namelist():
        return []
    with zf.open(fname) as fh:
        return parse_dat(fh.read(), COLUMNS[name])


def pt(dt_str):
    """'2026-09-21 10:12:21' (Pacific) -> ISO with offset."""
    if not dt_str:
        return None
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return iso(datetime.strptime(dt_str.strip(), fmt).replace(tzinfo=PACIFIC))
        except ValueError:
            continue
    return None


def vote_when(dt_str):
    """pubinfo stores floor and committee votes with a midnight time: the time of day is not
    recorded, so a midnight stamp becomes a plain date rather than a fake time."""
    if not dt_str:
        return None
    v = dt_str.strip()
    if v.endswith(' 00:00:00') or len(v) == 10:
        return v[:10]
    return pt(v)


def leginfo_url(bill_id, view='billNavClient'):
    return 'https://leginfo.legislature.ca.gov/faces/%s.xhtml?bill_id=%s' % (view, bill_id)


def member_id(house, district_num, author_name=None):
    """Seat ids are per district; a former occupant of the seat gets the author name appended
    so two people who held the same district in one session keep separate records."""
    base = 'ca-%s-%02d' % ('asm' if house == 'A' else 'sen', district_num)
    return base + '-' + slugify(author_name) if author_name else base


def is_active(r):
    return (r.get('active_legislator') or r.get('active_flg') or '') == 'Y'


def house_of(location_code):
    """'A' for Assembly floor files and committees (A..., CX..), 'S' for Senate (S..., CS..), None for joint."""
    code = location_code or ''
    if code.startswith('CONF'):
        return None
    return 'A' if code.startswith('A') or code.startswith('CX') else 'S'


def body_of(location_code):
    h = house_of(location_code)
    return 'ca-assembly' if h == 'A' else 'ca-senate' if h == 'S' else 'ca-legislature'


def build(zf, session, manifest_note, today=None):
    today = today or date.today()
    legislators = [r for r in read_table(zf, 'LEGISLATOR_TBL') if r['session_year'] == session]
    bills_raw = [r for r in read_table(zf, 'BILL_TBL') if r['session_year'] == session]
    versions = read_table(zf, 'BILL_VERSION_TBL')
    history = read_table(zf, 'BILL_HISTORY_TBL')
    summary = read_table(zf, 'BILL_SUMMARY_VOTE_TBL')
    detail = read_table(zf, 'BILL_DETAIL_VOTE_TBL')
    motions = {r['motion_id']: (r['motion_text'] or '').strip() for r in read_table(zf, 'BILL_MOTION_TBL')}
    locations = {r['location_code']: r for r in read_table(zf, 'LOCATION_CODE_TBL') if r['session_year'] == session}
    daily = read_table(zf, 'DAILY_FILE_TBL')
    hearings = read_table(zf, 'COMMITTEE_HEARING_TBL')
    agendas = read_table(zf, 'COMMITTEE_AGENDA_TBL')
    authors = read_table(zf, 'BILL_VERSION_AUTHORS_TBL')

    bill_ids = {r['bill_id'] for r in bills_raw}

    # ---- members
    # BILL_DETAIL_VOTE_TBL names legislators by author_name ("Laird", "Ochoa Bogh"), so the
    # lookup keys on that. A vacant seat is a row with NULL names and is skipped. When a
    # district has several rows in one session (resignation, special election) the active
    # occupant keeps the plain seat id and the others get their name appended.
    members = {}
    vacant = []
    name_index = {}   # (house, author_name) -> member id
    by_seat = defaultdict(list)
    for r in legislators:
        m = re.match(r'([AS])D(\d+)', r['district'] or '')
        if not m:
            continue
        seat = (m.group(1), int(m.group(2)))
        if r['author_name'] or r['legislator_name']:
            by_seat[seat].append(r)
        elif is_active(r):
            vacant.append(member_id(*seat))
        by_seat.setdefault(seat, [])
    for (house, num), rows in sorted(by_seat.items()):
        # one person can appear twice with different spellings (accents added later); group by slug
        people = []
        for r in sorted(rows, key=lambda r: (is_active(r), r['trans_update'] or ''), reverse=True):
            author = (r['author_name'] or r['legislator_name']).strip()
            key = slugify(author)
            for p in people:
                if p[0] == key:
                    p[2].append(author)
                    break
            else:
                people.append((key, r, [author]))
        for i, (key, r, names) in enumerate(people):
            mid = member_id(house, num, None if i == 0 else names[0])
            seat_vacant = member_id(house, num) in vacant
            members[mid] = {
                'id': mid, 'level': 'state', 'jurisdiction': 'us-ca', 'body': 'ca-assembly' if house == 'A' else 'ca-senate',
                'name': ' '.join(x for x in [r['first_name'], r['last_name']] if x) or r['legislator_name'],
                'first': r['first_name'], 'last': r['last_name'], 'party': {'DEM': 'D', 'REP': 'R', 'IND': 'I'}.get((r['party'] or '').upper(), (r['party'] or '')[:1]),
                'party_name': {'DEM': 'Democrat', 'REP': 'Republican', 'IND': 'Independent'}.get((r['party'] or '').upper(), r['party']),
                'state': 'CA', 'district': num, 'active': is_active(r) and i == 0 and not seat_vacant,
                'vote_name': r['legislator_name'], 'author_name': names[0],
                'urls': {'official': ('https://www.assembly.ca.gov/assemblymembers' if house == 'A' else 'https://www.senate.ca.gov/senators')},
                'source_updated_at': pt(r['trans_update']),
            }
            for n in names:
                name_index.setdefault((house, n), mid)

    # a vote recorded under an earlier form of a name ("Weber" for "Weber Pierson") matches when the
    # slug is a leading part of exactly one member's name in that house
    loose = defaultdict(list)
    for (h, n), mid in name_index.items():
        parts = slugify(n).split('-')
        for i in range(1, len(parts)):
            if mid not in loose[(h, '-'.join(parts[:i]))]:
                loose[(h, '-'.join(parts[:i]))].append(mid)
        last = slugify(members[mid]['last'] or '')
        if last and mid not in loose[(h, last)]:
            loose[(h, last)].append(mid)

    def member_for(location_code, name):
        h = house_of(location_code)
        for house in ([h] if h else ['A', 'S']):
            hit = name_index.get((house, name))
            if hit:
                return hit
            cands = loose.get((house, slugify(name))) or []
            if len(cands) == 1:
                return cands[0]
        return None

    # ---- bills
    latest_version = {r['bill_version_id']: r for r in versions}
    latest_hist = {}
    for h in history:
        if h['bill_id'] not in bill_ids:
            continue
        seq = int(h['action_sequence'] or 0)
        if h['bill_id'] not in latest_hist or seq > latest_hist[h['bill_id']][0]:
            latest_hist[h['bill_id']] = (seq, h)
    primary_authors = defaultdict(list)
    for a in authors:
        if a['primary_author_flg'] == 'Y' and a['active_flg'] == 'Y':
            primary_authors[a['bill_version_id']].append({'name': a['name'], 'house': a['house'], 'type': a['type']})

    bills = {}
    for r in bills_raw:
        v = latest_version.get(r['latest_bill_version_id']) or {}
        h = latest_hist.get(r['bill_id'], (0, {}))[1]
        label = '%s %s' % (r['measure_type'], r['measure_num'])
        bills[r['bill_id']] = {
            'id': r['bill_id'], 'level': 'state', 'jurisdiction': 'us-ca', 'session': session,
            'label': label, 'measure_type': r['measure_type'], 'number': int(r['measure_num'] or 0),
            'title': (v.get('subject') or '').strip() or None,
            'status': r['current_status'], 'location': (locations.get(r['current_location'] or '') or {}).get('description') or r['current_location'],
            'house': r['current_house'], 'chapter': ('Chapter %s, Statutes of %s' % (r['chapter_num'], r['chapter_year'])) if r['chapter_num'] and r['chapter_num'] != '0' else None,
            'latest_action': {'date': (h.get('action_date') or '')[:10] or None, 'text': (h.get('action') or '').strip() or None} if h else None,
            'introduced': (v.get('bill_version_action_date') or '')[:10] if v.get('version_num') == '99' else None,
            'sponsors': primary_authors.get(r['latest_bill_version_id'], []),
            'urgency': v.get('urgency') == 'Yes', 'fiscal': v.get('fiscal_committee') == 'Yes', 'vote_required': v.get('vote_required'),
            'vote_ids': [], 'official_url': leginfo_url(r['bill_id']), 'votes_url': leginfo_url(r['bill_id'], 'billVotesClient'),
            'source': {'id': 'ca-leginfo-pubinfo', 'name': 'California Legislature (LegInfo pubinfo)', 'url': BASE},
            'source_updated_at': pt(r['trans_update']),
        }
    # introduced date: version 99 is the introduced version
    for v in versions:
        if v['version_num'] == '99' and v['bill_id'] in bills:
            bills[v['bill_id']]['introduced'] = (v['bill_version_action_date'] or '')[:10] or None

    # ---- votes
    detail_by_key = defaultdict(list)
    for d in detail:
        if d['bill_id'] in bill_ids:
            detail_by_key[(d['bill_id'], d['location_code'], d['vote_date_time'], d['vote_date_seq'])].append(d)
    votes = []
    for s in summary:
        if s['bill_id'] not in bill_ids:
            continue
        key = (s['bill_id'], s['location_code'], s['vote_date_time'], s['vote_date_seq'])
        loc = locations.get(s['location_code'] or '', {})
        body = body_of(s['location_code'])
        is_floor = (s['location_code'] or '') in ('AFLOOR', 'SFLOOR')
        positions, labels = [], {}
        for d in sorted(detail_by_key.get(key, []), key=lambda d: int(d['member_order'] or 0)):
            code = VOTE_CODES.get((d['vote_code'] or '').strip().upper(), 'O')
            labels.setdefault(code, (d['vote_code'] or '').strip())
            name = (d['legislator_name'] or '').strip()
            mid = member_for(s['location_code'], name) or ('ca-name-' + slugify(name))
            positions.append([mid, code])
        when = vote_when(s['vote_date_time'])
        vid = 'ca-%s-%s-%s-%s' % (s['bill_id'], (s['location_code'] or '').lower(), re.sub(r'\D', '', s['vote_date_time'] or '')[:8], s['vote_date_seq'] or '0')
        ayes, noes, abst = int(s['ayes'] or 0), int(s['noes'] or 0), int(s['abstain'] or 0)
        result = (s['vote_result'] or '').strip().strip('()').strip()
        votes.append({
            'id': vid, 'level': 'state', 'jurisdiction': 'us-ca', 'body': body, 'session': session,
            'date': when, 'question': motions.get(s['motion_id'], '') or ('Floor vote' if is_floor else 'Committee vote'),
            'title': bills[s['bill_id']]['label'] + (': ' + bills[s['bill_id']]['title'] if bills[s['bill_id']].get('title') else ''),
            'location': loc.get('description') or s['location_code'], 'location_code': s['location_code'], 'floor': is_floor,
            'result': result, 'passed': result.upper().startswith(('PASS', 'AYE', 'ADOPT', 'CONCUR')),
            'tally': {'yes': ayes, 'no': noes, 'present': 0, 'not_voting': abst},
            'bill_id': s['bill_id'], 'bill_label': bills[s['bill_id']]['label'],
            'labels': labels, 'positions': positions,
            'official_url': leginfo_url(s['bill_id'], 'billVotesClient'),
            'source': {'id': 'ca-leginfo-pubinfo', 'name': 'California Legislature (LegInfo pubinfo)', 'url': BASE},
            'source_updated_at': pt(s['trans_update']),
        })
        bills[s['bill_id']]['vote_ids'].append(vid)
    votes.sort(key=lambda v: (v['date'] or '', v['id']))
    for b in bills.values():
        b['vote_ids'] = sorted(set(b['vote_ids']))

    # ---- upcoming: daily file entries dated today or later, committee hearings ahead
    horizon = (today + timedelta(days=UPCOMING_DAYS)).isoformat()
    today = today.isoformat()
    upcoming = []
    for r in daily:
        # the Daily File: floor files (location AF..../SF....) with the item number in file_location
        pub = (r['publication_date'] or '')[:10]
        if r['bill_id'] not in bills or not pub or pub < today or pub > horizon:
            continue
        loc = locations.get(r['location_code'] or '', {})
        floor = loc.get('location_type') == 'M' or (r['location_code'] or '')[:2] in ('AF', 'SF')
        upcoming.append({
            'id': 'ca-file-%s-%s-%s' % (r['bill_id'], (r['location_code'] or '').lower(), pub.replace('-', '')),
            'level': 'state', 'jurisdiction': 'us-ca', 'body': body_of(r['location_code']), 'kind': 'floor' if floor else 'committee',
            'date': pub, 'title': '%s: %s' % (bills[r['bill_id']]['label'], bills[r['bill_id']].get('title') or ''),
            'category': loc.get('long_description') or loc.get('description') or r['location_code'] or 'Daily File',
            'file_item': (r['file_location'] or '').strip() or None, 'consent': bool(r['consent_calendar_code']),
            'bill_id': r['bill_id'], 'bill_label': bills[r['bill_id']]['label'],
            'status': (r['status'] or 'scheduled').lower(), 'official_url': leginfo_url(r['bill_id']),
            'source': {'id': 'ca-leginfo-pubinfo', 'name': 'California Legislature Daily File (pubinfo)', 'url': BASE},
            'source_updated_at': pt(r['trans_update_date']),
        })
    for r in hearings:
        hd = (r['hearing_date'] or '')[:10]
        if r['bill_id'] not in bills or not hd or hd < today or hd > horizon:
            continue
        loc = locations.get(r['location_code'] or '', {})
        house = body_of(r['location_code'])
        upcoming.append({
            'id': 'ca-hearing-%s-%s-%s' % (r['bill_id'], (r['location_code'] or '').lower(), hd.replace('-', '')),
            'level': 'state', 'jurisdiction': 'us-ca', 'body': house, 'kind': 'committee', 'date': hd,
            'title': '%s: %s (%s hearing)' % (bills[r['bill_id']]['label'], bills[r['bill_id']].get('title') or '', loc.get('description') or r['location_code']),
            'category': 'Committee hearing', 'bill_id': r['bill_id'], 'bill_label': bills[r['bill_id']]['label'], 'status': 'scheduled',
            'official_url': leginfo_url(r['bill_id']),
            'source': {'id': 'ca-leginfo-pubinfo', 'name': 'California Legislature committee hearings (pubinfo)', 'url': BASE},
            'source_updated_at': pt(r['trans_update_date']),
        })
    seen = set()
    upcoming = [u for u in upcoming if not (u['id'] in seen or seen.add(u['id']))]
    for r in agendas:
        ad = (r['agenda_date'] or '')[:10]
        if not ad or ad < today or ad > horizon:
            continue
        loc = locations.get(r['committee_code'] or '', {})
        house = body_of(r['committee_code'])
        where = ', '.join(x.strip() for x in [r['line1'], r['line2'], r['line3'], r['building_type'], r['room_num']] if x and x.strip())
        upcoming.append({
            'id': 'ca-agenda-%s-%s' % (slugify(r['committee_code'] or ''), ad.replace('-', '')), 'level': 'state', 'jurisdiction': 'us-ca',
            'body': house, 'kind': 'committee', 'date': ad,
            'time': (r['agenda_time'] or '').strip() or None, 'tz': 'America/Los_Angeles',
            'title': '%s meets' % (loc.get('description') or r['committee_desc'] or r['committee_code']), 'location': where or None,
            'category': 'Committee agenda', 'status': 'scheduled', 'official_url': 'https://www.assembly.ca.gov/schedules-publications/daily-file' if house == 'ca-assembly' else 'https://www.senate.ca.gov/dailyfile',
            'source': {'id': 'ca-leginfo-pubinfo', 'name': 'California Legislature committee agendas (pubinfo)', 'url': BASE},
            'source_updated_at': None,
        })
    return {'members': members, 'vacant': sorted(vacant), 'bills': bills, 'votes': votes, 'upcoming': upcoming}


VOTE_COLUMNS = ['id', 'date', 'location', 'question', 'title', 'result', 'passed', 'yes', 'no', 'other', 'bill_id', 'floor']
BILL_COLUMNS = ['id', 'label', 'title', 'latest_action_date', 'status', 'location', 'votes']
TITLE_MAX = 120


def vote_row(v):
    """Compact index row; location is the code (the shard carries a code -> name map) and the
    title is capped, the per-bill file has the rest."""
    return [v['id'], v['date'], v['location_code'], v['question'], (v['title'] or '')[:TITLE_MAX], v['result'], v['passed'],
            v['tally']['yes'], v['tally']['no'], v['tally']['not_voting'], v['bill_id'], v['floor']]


def bill_row(bid, b):
    la = b.get('latest_action') or {}
    return [bid, b['label'], (b.get('title') or '')[:TITLE_MAX], la.get('date'), b.get('status'), b.get('location'), len(b['vote_ids'])]


def bill_shard(bill_id, session):
    m = re.match(r'%s0?([A-Z]+)(\d+)' % session, bill_id)
    kind, num = (m.group(1), int(m.group(2))) if m else ('X', 0)
    return 'bills/%s/%s-%02d.json' % (session, kind, num // 100)


def write_outputs(built, session, manifest):
    members, bills, votes, upcoming = built['members'], built['bills'], built['votes'], built['upcoming']
    member_rows = sorted(members.values(), key=lambda m: (m['body'], m['district'], not m['active']))
    writer.write_json('us-ca/members.json', {'members': member_rows, 'vacant': built['vacant'], 'session': session})
    location_names = {}
    for v in votes:
        location_names.setdefault(v['location_code'], v['location'])
    # every vote on a bill, with positions, in one file
    by_bill = defaultdict(list)
    for v in votes:
        by_bill[v['bill_id']].append(v)
    keep = set()
    for bid, vs in by_bill.items():
        writer.write_json('us-ca/votes/%s/%s.json' % (session, bid), {'votes': vs})
        keep.add(bid + '.json')
    if not LIMIT:
        writer.remove_stale('us-ca/votes/%s' % session, keep)
    # vote index shards: one per house and month, listed in votes/index.json
    shards = defaultdict(list)
    for v in votes:
        shards[(v['body'].split('-')[1], (v['date'] or '0000-00')[:7])].append(v)
    shard_list = []
    keep = set()
    for (house, month), vs in sorted(shards.items()):
        vs.sort(key=lambda v: (v['date'] or '', v['id']), reverse=True)
        name = '%s-%s-%s.json' % (session, house, month)
        keep.add(name)
        shard_list.append({'file': name, 'body': 'ca-' + house, 'month': month, 'votes': len(vs), 'floor': sum(1 for v in vs if v['floor'])})
        writer.write_json('us-ca/votes/' + name, {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in vs],
                                                  'locations': {c: location_names[c] for c in sorted({v['location_code'] for v in vs})}})
    keep.add('index.json')
    if not LIMIT:
        writer.remove_stale('us-ca/votes', keep)
    writer.write_json('us-ca/votes/index.json', {'session': session, 'shards': shard_list, 'locations': location_names, 'columns': VOTE_COLUMNS})
    # member x vote matrix, one file per house and year
    keep = set()
    for house in ('assembly', 'senate'):
        by_year = defaultdict(list)
        for v in votes:
            if v['body'] == 'ca-' + house:
                by_year[(v['date'] or '0000')[:4]].append(v)
        for year, vs in by_year.items():
            vs.sort(key=lambda v: (v['date'] or '', v['id']))
            rows = {}
            for i, v in enumerate(vs):
                for mid, code in v['positions']:
                    rows.setdefault(mid, ['-'] * len(vs))[i] = code
            name = '%s-%s-%s.json' % (house, session, year)
            keep.add(name)
            writer.write_json('us-ca/records/' + name, {'votes': [v['id'] for v in vs], 'dates': [v['date'] for v in vs], 'floor': [v['floor'] for v in vs],
                                                        'members': {k: ''.join(r) for k, r in sorted(rows.items())}, 'codes': CODE_LABELS})
    if not LIMIT:
        writer.remove_stale('us-ca/records', keep)
    # bills: an index per measure type plus detail shards of a hundred bills
    by_type = defaultdict(list)
    shard_data = defaultdict(dict)
    for bid, b in sorted(bills.items(), key=lambda kv: (kv[1]['measure_type'], kv[1]['number'])):
        by_type[b['measure_type']].append(bill_row(bid, b))
        shard_data[bill_shard(bid, session)][bid] = b
    keep = set()
    for mtype, rows in by_type.items():
        name = 'index-%s.json' % mtype
        keep.add(name)
        writer.write_json('us-ca/bills/%s/%s' % (session, name), {'columns': BILL_COLUMNS, 'rows': rows})
    for rel, data in shard_data.items():
        keep.add(rel.split('/')[-1])
        writer.write_json('us-ca/' + rel, {'bills': data})
    keep.add('index.json')
    if not LIMIT:
        writer.remove_stale('us-ca/bills/%s' % session, keep)
    writer.write_json('us-ca/bills/%s/index.json' % session, {'session': session, 'columns': BILL_COLUMNS,
                                                              'types': {t: {'file': 'index-%s.json' % t, 'bills': len(r)} for t, r in sorted(by_type.items())}})
    upcoming.sort(key=lambda u: (u['date'], u.get('time') or '', u['title']))
    writer.write_json('us-ca/upcoming.json', {'items': upcoming, 'horizon_days': UPCOMING_DAYS})
    latest = sorted(votes, key=lambda v: (v['date'] or '', v['id']), reverse=True)[:30]
    writer.write_json('us-ca/latest.json', {'columns': VOTE_COLUMNS, 'rows': [vote_row(v) for v in latest],
                                            'locations': {c: location_names[c] for c in sorted({v['location_code'] for v in latest})}})
    search = [['member', m['id'], m['name'], '%s %s %d' % (m['party'], 'AD' if m['body'] == 'ca-assembly' else 'SD', m['district']), m['body']] for m in member_rows if m['active']]
    search += [['bill', bid, '%s %s' % (b['label'], (b.get('title') or '')[:TITLE_MAX]), b.get('status') or '', 'ca-assembly' if b['measure_type'].startswith('A') or b['measure_type'] == 'HR' else 'ca-senate'] for bid, b in sorted(bills.items())]
    writer.write_json('search/us-ca.json', {'columns': ['type', 'id', 'label', 'meta', 'body'], 'rows': search})
    manifest.count('ca_members', len(member_rows))
    manifest.count('ca_bills', len(bills))
    manifest.count('ca_votes', len(votes))
    manifest.count('ca_upcoming', len(upcoming))


def main(argv=None):
    http = Http()
    manifest = Manifest()
    sid = 'ca-leginfo-pubinfo'
    manifest.describe(sid, 'California Legislature nightly database dump (LegInfo pubinfo)', BASE, 'state')
    session = current_session_year()
    dump = os.environ.get('PUBINFO_ZIP')     # local test hook: use an already downloaded dump
    listed = None
    try:
        if not dump:
            index_html, _ = http.get_text(BASE, ttl=0)
            picked = pick_latest_dump(index_html)
            if not picked:
                raise RuntimeError('no pubinfo_daily_*.zip in the directory listing')
            url, listed = picked
            dump = os.path.join(http.cache_dir, 'pubinfo_daily.zip')
            stamp_file = dump + '.stamp'
            have = open(stamp_file).read().strip() if os.path.exists(stamp_file) else ''
            if have != listed or not os.path.exists(dump):
                print('   downloading %s (listed %s)' % (url, listed))
                download(http, url, dump)
                with open(stamp_file, 'w') as fh:
                    fh.write(listed)
            else:
                print('   reusing cached dump listed %s' % listed)
        with zipfile.ZipFile(dump) as zf:
            built = build(zf, session, listed)
    except Exception as e:
        manifest.error(sid, e)
        manifest.save()
        raise
    write_outputs(built, session, manifest)
    source_updated = None
    if listed:
        try:
            source_updated = iso(datetime.strptime(listed, '%Y-%m-%d %H:%M').replace(tzinfo=PACIFIC))
        except ValueError:
            pass
    manifest.ok(sid, source_updated_at=source_updated, note='session %s' % session)
    manifest.save()
    print('   session %s: %d members (%d vacant seats), %d bills, %d votes, %d upcoming' % (session, len(built['members']), len(built['vacant']), len(built['bills']), len(built['votes']), len(built['upcoming'])))


if __name__ == '__main__':
    main()
