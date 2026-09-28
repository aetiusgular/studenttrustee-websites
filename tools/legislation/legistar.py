"""
County governments outside California that publish through Granicus Legistar's public API.

Finding them (the probe). Legistar names each customer with a short "client" string
(kingcounty, cook-county, harriscountytx) and answers
https://webapi.legistar.com/v1/{client}/bodies for every client, with no key. An unknown client
answers HTTP 500 ("LegistarConnectionString setting is not set up"). For each county the probe
tries a few names built from its website's host (harriscountytx.gov -> harriscountytx) and from
its name (traviscountytx, traviscounty, travis-county, travis). A name that answers is only
kept when something ties it to the county: the client's public site
(https://{client}.legistar.com/Calendar.aspx) links the county's own website as Wikidata records
it, or the site's title names the county with its state (or a county name no other county has),
or the client's name spells out the county and the state. A bare name can belong to a city
(maricopa is the City of Maricopa, madison is Madison, Wisconsin) and a county name repeats
across states (cook-county is Cook County, Illinois, not Georgia's; there are 30 Washington
Counties), so a client that more than one county could claim goes to the one it links, or to none.
The probe covers a thirtieth of the counties each night, so every county is tried once a month,
and its findings are kept in geo/legistar.json (started from legistar-initial.json, a full probe run
when this was written). Counties found by hand, where no name built this way matches
(consolidated city-counties such as Nashville, independent cities), are in legistar-seed.json.

    python3 -m tools.legislation.legistar --probe-all [--states TX,WA]   # try every county now

Collecting from them is the same as for California's counties (counties.py): meetings of the
last 90 days, their agenda actions and each member's vote.
"""
import json
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from urllib.parse import urlparse

from . import writer
from .common import USER_AGENT, UTC, FetchError, clock, clock_note, iso, now_iso, today

API = 'https://webapi.legistar.com/v1/%s/%s'
INSITE = 'https://%s.legistar.com/Calendar.aspx'
SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'legistar-seed.json')
INITIAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'legistar-initial.json')
STATE_FILE = 'geo/legistar.json'
PROBE_DAYS = 30
TIMEOUT = 10
WORKERS = 8
SUFFIXES = (' City and Borough', ' Census Area', ' County', ' Parish', ' Borough', ' Municipality', ' Municipio', ' city')
# What a county's governing body is called, most specific first.
BODY_WORDS = ('board of supervisors', 'board of county commissioners', 'board of commissioners', 'county commissioners',
              'commissioners court', 'commissioners\' court', 'county commission', 'fiscal court', 'quorum court', 'county council',
              'county legislature', 'county board', 'metropolitan council', 'metro council', 'police jury', 'parish council',
              'assembly', 'legislature', 'council', 'commission', 'bocc')


# ---------- collecting a board's meetings and votes (California's counties and the rest) ----------

LOOKBACK_DAYS = 90
LIMIT = int(os.environ.get('LEGIS_LIMIT', '0') or 0)
NEW_BOARDS = int(os.environ.get('LEGIS_NEW_BOARDS', '12') or 12)
# Each county names its vote values differently (seen: Aye/Ayes/AYE/Yes, Nay/Noes/NO/No, Absent,
# NOT PRESENT, Recuse/Recused, Abstain/Abstained). Anything unrecognised is kept as O (other).
VOTE_CODES = {'AYE': 'Y', 'AYES': 'Y', 'YES': 'Y', 'YEA': 'Y', 'YEAS': 'Y',
              'NO': 'N', 'NOES': 'N', 'NAY': 'N', 'NAYS': 'N',
              'ABSTAIN': 'A', 'ABSTAINED': 'A', 'ABSTENTION': 'A',
              'ABSENT': 'X', 'EXCUSED': 'X', 'NOT VOTING': 'X', 'NOT PRESENT': 'X', 'DID NOT VOTE': 'X',
              'RECUSED': 'R', 'RECUSE': 'R', 'RECUSAL': 'R', 'PRESENT': 'P'}
CODE_LABELS = {'Y': 'aye', 'N': 'no', 'A': 'abstain', 'X': 'absent or not voting', 'R': 'recused', 'P': 'present', 'O': 'other', '-': 'not on this roll'}
VOTE_COLUMNS = ['id', 'date', 'meeting_id', 'agenda_number', 'question', 'matter_id', 'result', 'passed', 'yes', 'no', 'other', 'positions', 'mover', 'seconder', 'source_updated_at']
LATEST_COLUMNS = ['id', 'date', 'body', 'county', 'question', 'matter_label', 'matter_title', 'result', 'passed', 'yes', 'no', 'other', 'recorded']


def vote_code(label):
    return VOTE_CODES.get(' '.join((label or '').upper().split()), 'O')


def utc(value):
    """Legistar '2026-09-03T21:48:39.187' (UTC, no offset) or '2026-09-01T00:00:00' dates."""
    if not value:
        return None
    m = re.match(r'(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})', value)
    if not m:
        return value
    return iso(datetime.strptime(m.group(1) + 'T' + m.group(2), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=UTC))


def sitting(body_name, board='Board of Supervisors'):
    """A sitting of the board, named without the board: 'BOARD OF SUPERVISORS - LAND USE' ->
    'Land Use', 'Special Meeting of the Board of Supervisors' -> 'Special Meeting'; the board itself -> ''."""
    n = ' '.join((body_name or '').split())
    if n.lower() == ' '.join(board.split()).lower():
        return ''
    b = re.escape(' '.join(board.split()))
    rest = re.sub(r'(?i)^' + b + r'\s*[-:\u2013]?\s*', '', n)
    rest = re.sub(r'(?i)\s*of the ' + b + r'$', '', rest)
    return rest.title() if rest.isupper() else rest


def collect_board(http, client, st, fips, county_name, boards, board_title, member_title, tz, board_word='Board of Supervisors'):
    """Meetings, agenda items, votes and members of one county's governing body on Legistar.

    boards: the client's bodies that are the board or its sittings, the board itself first.
    board_title: what the site calls the board ('San Diego Board of Supervisors').
    Returns (members, meetings, votes, matters). Raises on a hard failure of the board itself."""
    prefix = '%s-%s-bos' % (st.lower(), fips)
    jurisdiction = 'us-%s-%s' % (st.lower(), fips)
    body_id = boards[0]['BodyId']
    source = {'id': 'legistar-' + client, 'name': '%s Legistar' % county_name}
    since = (today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    until = (today() + timedelta(days=400)).isoformat()     # some boards file template meetings years ahead
    events = []
    for b in boards:
        try:
            evs, _ = http.get_json(API % (client, "events?$filter=EventBodyId eq %d and EventDate ge datetime'%s' and EventDate le datetime'%s'&$orderby=EventDate desc&$top=200" % (b['BodyId'], since, until)), ttl=0)
        except FetchError as e:
            if b is boards[0]:
                raise
            print('   %s: %s events skipped: %s' % (client, b.get('BodyName'), e))
            continue
        for ev in evs:
            ev['_body_name'] = (b.get('BodyName') or '').strip()
        events += evs
    events.sort(key=lambda ev: ev.get('EventDate') or '', reverse=True)
    if LIMIT:
        events = events[:max(2, LIMIT // 5)]
    # the API ignores $filter on officerecords, so the current members are picked out here
    records, _ = http.get_json(API % (client, "bodies/%d/officerecords?$filter=OfficeRecordEndDate ge datetime'%s'&$top=100" % (body_id, today().isoformat())), ttl=24 * 3600)
    today_s = today().isoformat()
    members = {}
    for r in sorted(records, key=lambda r: r.get('OfficeRecordStartDate') or ''):
        pid = r.get('OfficeRecordPersonId')
        start, end = (r.get('OfficeRecordStartDate') or '')[:10], (r.get('OfficeRecordEndDate') or '')[:10]
        if not pid or (end and end < today_s) or (start and start > today_s):
            continue
        mid = '%s-%s' % (prefix, pid)
        members[mid] = {'id': mid, 'level': 'county', 'jurisdiction': jurisdiction, 'body': prefix,
                        'name': ' '.join((r.get('OfficeRecordFullName') or '').split()), 'first': r.get('OfficeRecordFirstName'), 'last': r.get('OfficeRecordLastName'),
                        'title': (r.get('OfficeRecordTitle') or '').strip() or member_title, 'state': st, 'county': county_name,
                        'term_start': start or None, 'term_end': end or None,
                        'ids': {'legistar_person': pid}, 'urls': {'official': 'https://%s.legistar.com/People.aspx' % client},
                        'source_updated_at': utc(r.get('OfficeRecordLastModifiedUtc'))}
    name_to_id = {' '.join(m['name'].lower().split()): mid for mid, m in members.items()}

    meetings, votes, matters = [], [], {}
    for ev in events:
        ev_date = (ev.get('EventDate') or '')[:10]
        eid = ev['EventId']
        if not ev_date or ev_date > until:
            continue     # Legistar template events dated 2099 and the like
        if (ev.get('EventAgendaStatusName') or '').strip().lower() == 'hidden':
            continue     # not public yet (Humboldt posts future meetings this way)
        part = sitting(ev['_body_name'], board_word)
        meeting = {'id': '%s-meeting-%s' % (prefix, eid), 'level': 'county', 'jurisdiction': jurisdiction, 'body': prefix,
                   'kind': 'meeting', 'date': ev_date, 'time': clock(ev.get('EventTime')), 'time_note': clock_note(ev.get('EventTime')), 'tz': tz,
                   'title': board_title + (' (%s)' % part if part else ''),
                   'location': (ev.get('EventLocation') or '').strip() or None,
                   'status': 'scheduled' if ev_date >= today_s else 'held',
                   'official_url': ev.get('EventInSiteURL') or ('https://%s.legistar.com/Calendar.aspx' % client),
                   'agenda_url': ev.get('EventAgendaFile'), 'minutes_url': ev.get('EventMinutesFile'),
                   'source': dict(source, url=API % (client, 'events/%s' % eid)),
                   'source_updated_at': utc(ev.get('EventLastModifiedUtc')), 'items': 0, 'votes': 0}
        past = ev_date < today_s
        try:
            items, _ = http.get_json(API % (client, 'events/%s/eventitems?AgendaNote=1&MinutesNote=1&Attachments=0' % eid), ttl=(7 * 24 * 3600 if past and ev.get('EventMinutesFile') else 0))
        except FetchError as e:
            print('   %s event %s items skipped: %s' % (client, eid, e))
            items = []
        meeting['items'] = len(items)
        for it in items:
            action = (it.get('EventItemActionName') or '').strip()
            passed_flag = it.get('EventItemPassedFlagName')
            mid = it.get('EventItemMatterId')
            if mid and mid not in matters:
                matters[mid] = {'id': '%s-matter-%s' % (prefix, mid), 'level': 'county', 'jurisdiction': jurisdiction, 'body': prefix,
                                'label': (it.get('EventItemMatterFile') or '').strip() or ('Item %s' % mid), 'title': (it.get('EventItemTitle') or '').strip(),
                                'type': (it.get('EventItemMatterType') or '').strip() or None, 'status': (it.get('EventItemMatterStatus') or '').strip() or None,
                                'official_url': 'https://%s.legistar.com/LegislationDetail.aspx?ID=%s' % (client, mid), 'vote_ids': [],
                                'source': dict(source, url=API % (client, 'matters/%s' % mid)),
                                'source_updated_at': utc(it.get('EventItemLastModifiedUtc'))}
            if not action and not passed_flag:
                continue
            positions, labels = [], {}
            if past:
                try:
                    vrows, _ = http.get_json(API % (client, 'eventitems/%s/votes' % it['EventItemId']), ttl=30 * 24 * 3600)
                except FetchError:
                    vrows = []
                for vr in vrows:
                    label = (vr.get('VoteValueName') or '').strip()
                    code = vote_code(label)
                    labels.setdefault(code, label)
                    pid = vr.get('VotePersonId')
                    member = '%s-%s' % (prefix, pid) if pid else name_to_id.get(' '.join((vr.get('VotePersonName') or '').lower().split()), '%s-unknown' % prefix)
                    if member not in members and pid:
                        members[member] = {'id': member, 'level': 'county', 'jurisdiction': jurisdiction, 'body': prefix,
                                           'name': ' '.join((vr.get('VotePersonName') or '').split()), 'title': member_title + ' (former)', 'state': st, 'county': county_name,
                                           'ids': {'legistar_person': pid}, 'urls': {}, 'provisional': True}
                    positions.append([member, code])
            yes = sum(1 for p in positions if p[1] == 'Y')
            no = sum(1 for p in positions if p[1] == 'N')
            other = len(positions) - yes - no
            result = passed_flag or action
            vote = {'id': '%s-vote-%s-%s' % (prefix, ev_date.replace('-', ''), it['EventItemId']), 'level': 'county', 'jurisdiction': jurisdiction, 'body': prefix,
                    'meeting_id': meeting['id'], 'date': ev_date, 'time': meeting['time'], 'tz': tz,
                    'question': action or ('Passed' if passed_flag == 'Pass' else result), 'title': ('%s: %s' % ((it.get('EventItemMatterFile') or '').strip(), (it.get('EventItemTitle') or '').strip())).strip(': '),
                    'agenda_number': (it.get('EventItemAgendaNumber') or '').strip() or None,
                    'result': result, 'passed': (passed_flag or '').lower().startswith('pass') or bool(re.search(r'adopt|approv|pass|carried', action, re.I)),
                    'tally': {'yes': yes, 'no': no, 'present': 0, 'not_voting': other}, 'recorded': bool(positions),
                    'mover': (it.get('EventItemMover') or '').strip() or None, 'seconder': (it.get('EventItemSeconder') or '').strip() or None,
                    'bill_id': matters[mid]['id'] if mid in matters else None, 'bill_label': matters[mid]['label'] if mid in matters else None,
                    'labels': labels, 'positions': positions,
                    'official_url': meeting['minutes_url'] or meeting['official_url'],
                    'source': dict(source, url=API % (client, 'eventitems/%s/votes' % it['EventItemId'])),
                    'source_updated_at': utc(it.get('EventItemLastModifiedUtc'))}
            votes.append(vote)
            meeting['votes'] += 1
            if mid in matters:
                matters[mid]['vote_ids'].append(vote['id'])
        meetings.append(meeting)
    return members, meetings, votes, matters


def write_board(folder, rec, members, meetings, votes, matters):
    """board.json plus one compact vote file per month under folder (us-ca/counties/06073).
    positions is a string in board member order. Returns rows for the latest-votes file."""
    order = [m['id'] for m in members]
    by_month = defaultdict(list)
    for v in votes:
        by_month[v['date'][:7]].append(v)
    keep = {'board.json'}
    months = []
    for month, vs in sorted(by_month.items()):
        vs.sort(key=lambda v: (v['date'], v['id']), reverse=True)
        rows = []
        used = set()
        for v in vs:
            pos = dict(v['positions'])
            rows.append([v['id'], v['date'], v['meeting_id'], v['agenda_number'], v['question'], v['bill_id'], v['result'], v['passed'],
                         v['tally']['yes'], v['tally']['no'], v['tally']['not_voting'], ''.join(pos.get(mid, '-') for mid in order),
                         v['mover'], v['seconder'], v['source_updated_at']])
            if v['bill_id']:
                used.add(v['bill_id'])
        name = 'votes-%s.json' % month
        keep.add(name)
        months.append({'file': name, 'month': month, 'votes': len(vs), 'recorded': sum(1 for v in vs if v['recorded'])})
        writer.write_json('%s/%s' % (folder, name), {
            'columns': VOTE_COLUMNS, 'members': order, 'codes': CODE_LABELS, 'rows': rows,
            'matters': {m['id']: m for m in matters.values() if m['id'] in used}})
    rec['members'] = members
    rec['meetings'] = meetings
    rec['vote_months'] = months
    rec['counts'] = {'meetings': len(meetings), 'votes': len(votes), 'matters': len(matters)}
    writer.write_json('%s/board.json' % folder, rec)
    if not LIMIT:
        writer.remove_stale(folder, keep)
    by_id = {m['id']: m for m in matters.values()}
    return [[v['id'], v['date'], rec['body'], rec['county'], v['question'], (by_id.get(v['bill_id']) or {}).get('label'),
             ((by_id.get(v['bill_id']) or {}).get('title') or '')[:160], v['result'], v['passed'],
             v['tally']['yes'], v['tally']['no'], v['tally']['not_voting'], v['recorded']] for v in votes]


def base_name(name):
    for suf in SUFFIXES:
        if name.endswith(suf):
            return name[:-len(suf)]
    return name


def host_of(url):
    try:
        h = (urlparse(url).hostname or '').lower()
    except ValueError:
        return ''
    return h[4:] if h.startswith('www.') else h


def candidates(name, st, site_url=None):
    """Client names to try, most likely first."""
    b = base_name(name).lower().replace("'", '').replace('.', '')
    squash = re.sub(r'[^a-z0-9]', '', b)
    hyphen = re.sub(r'[^a-z0-9]+', '-', b).strip('-')
    out = []
    label = host_of(site_url or '').split('.')[0] if site_url else ''
    if label and label not in ('co', 'county', 'gov', 'web', 'portal', 'www2'):
        out += [label, re.sub(r'gov$', '', label)]
    out += [squash + 'county' + st.lower(), squash + 'county', hyphen + '-county', squash]
    if st == 'LA':
        out.insert(0, squash + 'parish')
    return [c for c in dict.fromkeys(out) if c and len(c) >= 3]


def _session():
    import requests
    s = requests.Session()
    s.headers['User-Agent'] = USER_AGENT
    return s


def client_bodies(session, client):
    """(status, bodies): 'client' with the body list, 'none' for an unknown client, 'error' otherwise."""
    try:
        r = session.get(API % (client, 'bodies?$top=500'), timeout=TIMEOUT)
    except Exception as e:
        return 'error', str(e)[:80]
    if r.status_code == 200:
        try:
            data = r.json()
        except ValueError:
            return 'error', 'not JSON'
        return ('client', data) if isinstance(data, list) else ('error', 'not a list')
    if r.status_code == 500 and 'LegistarConnectionString' in r.text:
        return 'none', None
    return 'error', 'HTTP %s' % r.status_code


def insite(session, client):
    """(hosts the client's public Legistar site links to, the site's title)."""
    try:
        r = session.get(INSITE % client, timeout=TIMEOUT * 2)
    except Exception:
        return set(), ''
    if r.status_code != 200:
        return set(), ''
    m = re.search(r'<title>\s*(.*?)\s*</title>', r.text, re.S | re.I)
    title = ' '.join(m.group(1).split()) if m else ''
    return {host_of('https://' + h) for h in re.findall(r'https?://([a-z0-9.-]+\.[a-z]{2,})', r.text, re.I)}, title


def norm(s):
    return ' '.join((s or '').lower().replace('’', "'").split())


def pick_body(bodies, expected=None):
    """The governing body among a client's bodies: the one named as the state names county boards,
    else Legistar's 'Primary Legislative Body', else the first whose name says board or council."""
    active = [b for b in bodies or [] if b.get('BodyActiveFlag', 1) and b.get('BodyName')]

    def rank(b):
        n = norm(b['BodyName'])
        word = next((i for i, w in enumerate(BODY_WORDS) if w in n), 99)
        return (0 if expected and norm(expected) in n else 1, 0 if b.get('BodyTypeName') == 'Primary Legislative Body' else 1, word, len(n), b.get('BodyId') or 0)
    ranked = sorted(active, key=rank)
    if not ranked:
        return None
    best = ranked[0]
    r = rank(best)
    if r[0] and r[1] and r[2] == 99:
        return None
    if re.search(r'\b(city|town|village|common council|aldermen|alderman)\b', norm(best['BodyName'])) and 'county' not in norm(best['BodyName']):
        return None
    return {'id': best['BodyId'], 'name': ' '.join(best['BodyName'].split())}


def confirmation(client, c, site, session, unique):
    """Why a client that answers is taken to be this county's, or None. Its public site links the
    county's website (fulton.legistar.com links fultoncountyga.gov); or the site's title names the
    county and its state ("Alachua County, FL - Calendar", "Lake County Illinois - Meetings"), or
    names a county whose name no other county has ("Pinellas County - Calendar"); or the client's
    name spells out the county and the state (polkcountyfl)."""
    from . import districts
    hosts, title = insite(session, client)
    host = host_of(site or '')
    if host and host in hosts:
        return 'links %s' % host
    name = norm(c['name']).replace('saint ', 'st. ')
    head = norm(title.split(' - ')[0]).replace('saint ', 'st. ')
    if head.startswith(name):
        rest = head[len(name):]
        state_name = districts.STATES[c['state']][0].lower()
        if re.search(r'(^|[ ,])(%s|%s)\b' % (re.escape(c['state'].lower()), re.escape(state_name)), rest):
            return 'titled %s' % title.split(' - ')[0]
        if not rest.strip(' ,') and unique.get(name, 0) == 1:
            return 'titled %s, the only county of that name' % title.split(' - ')[0]
    squash = re.sub(r'[^a-z0-9]', '', base_name(c['name']).lower().replace("'", ''))
    if client in (squash + 'county' + c['state'].lower(), squash + 'parish' + c['state'].lower()):
        return 'named with the county and state'
    return None


def probe_county(session, c, expected=None, unique=None):
    """One county: {'client', 'body', 'confirmed_by'} when found, {'result': ...} otherwise."""
    site = (c.get('board') or {}).get('source_url') or (c.get('board') or {}).get('url')
    tried, notes = [], []
    for client in candidates(c['name'], c['state'], site):
        status, bodies = client_bodies(session, client)
        if status == 'error' and 'timed out' in str(bodies):
            status, bodies = client_bodies(session, client)      # Legistar is slow at times; one more try
        tried.append(client)
        if status == 'error':
            notes.append('%s: %s' % (client, bodies))
            continue
        if status == 'none':
            continue
        body = pick_body(bodies, expected)
        if not body:
            notes.append('%s: answers, but has no county governing body' % client)
            continue
        why = confirmation(client, c, site, session, unique or {})
        if why:
            return {'client': client, 'body': body, 'confirmed_by': why}
        notes.append('%s: answers, but nothing ties it to this county' % client)
    unconfirmed = any('answers' in n for n in notes)
    return {'result': 'unconfirmed' if unconfirmed else 'error' if notes else 'none', 'tried': tried, 'notes': notes[:3]}


def due(fips, day):
    return int(fips) % PROBE_DAYS == day.toordinal() % PROBE_DAYS


def national_counties():
    """Every county outside California, with its state and board, from geo/us-{st}/counties.json."""
    from . import districts
    out = []
    for st in sorted(districts.STATES):
        if st == 'CA':
            continue
        geo = writer.read_json('geo/us-%s/counties.json' % st.lower()) or {}
        for c in geo.get('counties') or []:
            if (c.get('board') or {}).get('none'):
                continue
            out.append(dict(c, state=st))
    return out


def load_initial():
    """The counties found by a full probe when this code was written, so the first night collects
    them without waiting a month for the rotation. Only used until geo/legistar.json exists."""
    try:
        with open(INITIAL, encoding='utf-8') as fh:
            return {'schema_version': 1, 'clients': json.load(fh).get('clients') or {}, 'checked': {}}
    except FileNotFoundError:
        return None


def load_seed():
    try:
        with open(SEED, encoding='utf-8') as fh:
            return json.load(fh).get('counties') or {}
    except FileNotFoundError:
        return {}


def name_counts():
    """How many counties in the country share each full name ('orange county': 8)."""
    idx = writer.read_json('geo/counties.json') or {}
    out = {}
    for row in idx.get('rows') or []:
        n = norm(row[1]).replace('saint ', 'st. ')
        out[n] = out.get(n, 0) + 1
    return out


def settle(state):
    """A client claimed by more than one county belongs to the one whose confirmation is a link to
    its website; if none or several are, it belongs to none of them."""
    by_client = {}
    for fips, c in state['clients'].items():
        by_client.setdefault(c['client'], []).append(fips)
    for client, owners in by_client.items():
        if len(owners) < 2:
            continue
        linked = [f for f in owners if state['clients'][f]['confirmed_by'].startswith('links ')]
        for f in owners:
            if len(linked) != 1 or f != linked[0]:
                del state['clients'][f]
                state['checked'][f] = dict(state['checked'].get(f) or {}, result='shared %s' % client)


def probe(counties, day, everything=False, session=None, prober=None):
    """Probe the counties due tonight (or all) and merge the results into geo/legistar.json.
    Returns the state document."""
    from . import boards
    state = writer.read_json(STATE_FILE) or load_initial() or {'schema_version': 1, 'clients': {}, 'checked': {}}
    todo = [c for c in counties if everything or due(c['fips'], day) or c['fips'] not in state['checked']][:(None if everything else 400)]
    unique = name_counts()
    session = session or (_session() if prober is None else None)
    prober = prober or (lambda c: probe_county(session, c, boards.BOARD_NAME.get(c['state']), unique))
    with ThreadPoolExecutor(WORKERS) as pool:
        results = list(pool.map(prober, todo))
    stamp = now_iso()
    for c, res in zip(todo, results):
        state['checked'][c['fips']] = {'at': stamp, 'result': 'found' if res.get('client') else res.get('result')}
        if res.get('client'):
            state['clients'][c['fips']] = {'state': c['state'], 'name': c['name'], 'client': res['client'], 'body': res['body'],
                                           'confirmed_by': res['confirmed_by'], 'found_at': (state['clients'].get(c['fips']) or {}).get('found_at') or stamp,
                                           'checked_at': stamp}
        elif res.get('result') == 'none' and c['fips'] in state['clients']:
            del state['clients'][c['fips']]        # no longer answers under that name
    settle(state)
    state['updated_at'] = stamp
    writer.write_json(STATE_FILE, state)
    return state


# Time zones: a state's usual zone, and the counties of split states that keep another one.
STATE_TZ = {'AL': 'America/Chicago', 'AK': 'America/Anchorage', 'AZ': 'America/Phoenix', 'AR': 'America/Chicago', 'CO': 'America/Denver',
            'CT': 'America/New_York', 'DE': 'America/New_York', 'DC': 'America/New_York', 'FL': 'America/New_York', 'GA': 'America/New_York',
            'HI': 'Pacific/Honolulu', 'ID': 'America/Boise', 'IL': 'America/Chicago', 'IN': 'America/Indiana/Indianapolis', 'IA': 'America/Chicago',
            'KS': 'America/Chicago', 'KY': 'America/New_York', 'LA': 'America/Chicago', 'ME': 'America/New_York', 'MD': 'America/New_York',
            'MA': 'America/New_York', 'MI': 'America/Detroit', 'MN': 'America/Chicago', 'MS': 'America/Chicago', 'MO': 'America/Chicago',
            'MT': 'America/Denver', 'NE': 'America/Chicago', 'NV': 'America/Los_Angeles', 'NH': 'America/New_York', 'NJ': 'America/New_York',
            'NM': 'America/Denver', 'NY': 'America/New_York', 'NC': 'America/New_York', 'ND': 'America/Chicago', 'OH': 'America/New_York',
            'OK': 'America/Chicago', 'OR': 'America/Los_Angeles', 'PA': 'America/New_York', 'PR': 'America/Puerto_Rico', 'RI': 'America/New_York',
            'SC': 'America/New_York', 'SD': 'America/Chicago', 'TN': 'America/Chicago', 'TX': 'America/Chicago', 'UT': 'America/Denver',
            'VT': 'America/New_York', 'VA': 'America/New_York', 'WA': 'America/Los_Angeles', 'WV': 'America/New_York', 'WI': 'America/Chicago',
            'WY': 'America/Denver', 'CA': 'America/Los_Angeles'}
_CENTRAL = 'America/Chicago'
_EASTERN = 'America/New_York'
_MOUNTAIN = 'America/Denver'
COUNTY_TZ = {}
COUNTY_TZ.update({f: _MOUNTAIN for f in ('48141', '48229')})                                     # El Paso, Hudspeth (TX)
COUNTY_TZ.update({f: _CENTRAL for f in ('12033', '12113', '12091', '12131', '12059', '12133', '12005', '12063', '12013')})  # Florida panhandle
COUNTY_TZ.update({f: _EASTERN for f in ('47093', '47065', '47163', '47179', '47009', '47155', '47011', '47001', '47059', '47063', '47145',
                                         '47019', '47089', '47107', '47105', '47123', '47029', '47025', '47013', '47073', '47171', '47091',
                                         '47057', '47173', '47143', '47121', '47139', '47129', '47151', '47067')})      # East Tennessee
COUNTY_TZ.update({f: _CENTRAL for f in ('21227', '21059', '21145', '21047', '21101', '21107')})    # western Kentucky
COUNTY_TZ.update({f: _CENTRAL for f in ('18089', '18127', '18091', '18111', '18073', '18149', '18163', '18129', '18173', '18051', '18147', '18123')})  # Indiana corners
COUNTY_TZ.update({f: _CENTRAL for f in ('26053', '26071', '26043', '26109')})                    # Michigan's western Upper Peninsula
COUNTY_TZ.update({f: 'America/Los_Angeles' for f in ('16055', '16017', '16021', '16009', '16079', '16057', '16069', '16061', '16035')})  # north Idaho
COUNTY_TZ.update({'41045': 'America/Boise'})                                                    # Malheur (OR)
COUNTY_TZ.update({f: _MOUNTAIN for f in ('20071', '20075', '20181', '20199', '31157', '31013', '31045', '31165', '31161', '31033', '31105',
                                          '31007', '31123', '31069', '31049', '31101', '31135', '31029', '31057', '31075', '31005',
                                          '38089', '38011', '38001', '38007', '38033', '38041', '38087', '38037',
                                          '46103', '46081', '46093', '46019', '46033', '46047', '46102', '46063', '46105', '46071', '46007',
                                          '46137', '46041', '46031')})                                   # western Kansas, Nebraska, the Dakotas
MEMBER_TITLE = {'Commissioners Court': 'Commissioner', 'Board of Supervisors': 'Supervisor', 'County Council': 'Council member',
                'Fiscal Court': 'Magistrate', 'Quorum Court': 'Justice of the peace'}


def tz_of(st, fips):
    return COUNTY_TZ.get(fips) or STATE_TZ.get(st) or _EASTERN


def board_bodies(bodies, primary):
    """The governing body and its sittings ('Commissioners Court - Special Session',
    'Special Meeting of the County Council'), the body itself first."""
    name = norm(primary['name'])
    out = [b for b in bodies or [] if b.get('BodyId') == primary['id']]
    for b in bodies or []:
        n = norm(b.get('BodyName'))
        if b.get('BodyId') != primary['id'] and b.get('BodyActiveFlag', 1) and (n.startswith(name + ' ') or n.endswith(' of the ' + name)):
            out.append(b)
    return out


def board_title(county_name, geo_board, body_name):
    """'Harris County Commissioners Court', 'Metropolitan King County Council'."""
    base = base_name(county_name)
    if base.lower() in body_name.lower():
        return body_name if not body_name.isupper() else body_name.title()
    if geo_board and geo_board != 'County government':
        return '%s %s' % (county_name, geo_board)
    return '%s %s' % (county_name, body_name.title() if body_name.isupper() else body_name)


def collect(http, manifest, clients, geo_rows):
    """Meetings and votes of every county board on the list. Returns index entries, upcoming meetings
    and latest-vote rows."""
    from . import boards as board_names
    today_s = today().isoformat()
    index, upcoming, latest = [], [], []

    def one(fips):
        c, g = clients[fips], geo_rows.get(fips) or {}
        st = c['state']
        name = g.get('name') or c.get('name')
        geo_board = (g.get('board') or {}).get('name') or board_names.BOARD_NAME.get(st)
        sid = 'county-' + fips
        bodies, _ = http.get_json(API % (c['client'], 'bodies?$top=500'), ttl=24 * 3600)
        boards = board_bodies(bodies, c['body'])
        if not boards:
            raise RuntimeError('%s: body %s is gone from Legistar' % (c['client'], c['body'].get('name')))
        title = board_title(name, geo_board, c['body']['name'])
        members, meetings, votes, matters = collect_board(http, c['client'], st, fips, name, boards, title,
                                                          MEMBER_TITLE.get(geo_board, 'Member'), tz_of(st, fips), board_word=c['body']['name'])
        return sid, st, name, g, title, members, meetings, votes, matters

    # A board collected for the first time costs one request per agenda item (a few hundred), so at
    # most NEW_BOARDS new ones join each night; the rest follow on later nights. After the first
    # night a board costs only its new meetings, because finished votes are cached for a month.
    have = {f for f in clients if writer.read_json('us-%s/counties/%s/board.json' % (clients[f]['state'].lower(), f))}
    new = sorted(f for f in clients if f not in have)
    waiting = new[NEW_BOARDS:]
    todo = sorted(have) + new[:NEW_BOARDS]
    with ThreadPoolExecutor(6) as pool:
        futures = {fips: pool.submit(one, fips) for fips in todo}
    for fips, fut in sorted(futures.items()):
        c = clients[fips]
        st = c['state']
        sid = 'county-' + fips
        g = geo_rows.get(fips) or {}
        name = g.get('name') or c.get('name')
        folder = 'us-%s/counties/%s' % (st.lower(), fips)
        manifest.describe(sid, '%s, %s: %s' % (name, st, c['body']['name']), 'https://%s.legistar.com/Calendar.aspx' % c['client'], 'county', official=True)
        try:
            sid, st, name, g, title, members, meetings, votes, matters = fut.result()
        except Exception as e:
            manifest.error(sid, e)
            print('   %s, %s failed: %s' % (name, st, e))
            old = writer.read_json(folder + '/board.json')
            if old:
                index.append({k: old.get(k) for k in ('fips', 'state', 'county', 'slug', 'body', 'body_name', 'coverage', 'platform', 'urls', 'counts')})
            continue
        member_rows = sorted(members.values(), key=lambda m: (m.get('provisional', False), m['name']))
        meetings = sorted(meetings, key=lambda m: m['date'], reverse=True)
        coverage = 'votes' if any(v['recorded'] for v in votes) else 'agendas'
        site = (g.get('board') or {}).get('url')
        rec = {'fips': fips, 'state': st, 'county': name, 'slug': g.get('slug'), 'level': 'county', 'jurisdiction': 'us-%s-%s' % (st.lower(), fips),
               'body': '%s-%s-bos' % (st.lower(), fips), 'body_name': title, 'coverage': coverage, 'platform': 'Legistar',
               'urls': dict({'board_url': 'https://%s.legistar.com/Calendar.aspx' % c['client'], 'agenda_url': 'https://%s.legistar.com/Calendar.aspx' % c['client']}, **({'website': site} if site else {})),
               'found': {'client': c['client'], 'confirmed_by': c.get('confirmed_by'), 'found_at': c.get('found_at')}}
        latest += write_board(folder, rec, member_rows, meetings, votes, matters)
        entry = {k: rec[k] for k in ('fips', 'state', 'county', 'slug', 'body', 'body_name', 'coverage', 'platform', 'urls', 'counts')}
        entry.update({'members': len([m for m in member_rows if not m.get('provisional')]),
                      'latest_meeting': max((m['date'] for m in meetings if m['date'] < today_s), default=None),
                      'next_meeting': min((m['date'] for m in meetings if m['date'] >= today_s), default=None)})
        index.append(entry)
        upcoming += [dict(m, county=name, fips=fips, state=st) for m in meetings if m['date'] >= today_s]
        updated = max((m['source_updated_at'] for m in meetings if m.get('source_updated_at')), default=None)
        manifest.ok(sid, source_updated_at=updated, note='%d meetings, %d votes' % (len(meetings), len(votes)))
    if waiting:
        print('   %d county boards wait for their first collection: %s' % (len(waiting), ', '.join(waiting[:10])))
    return index, upcoming, latest


def main(argv=None):
    """Nightly: probe tonight's thirtieth of the counties, then collect every board found."""
    from .common import Http, Manifest
    argv = list(sys.argv[1:] if argv is None else argv)
    everything = '--probe-all' in argv
    states = None
    if '--states' in argv:
        states = {s.strip().upper() for s in argv[argv.index('--states') + 1].split(',')}
    counties = [c for c in national_counties() if not states or c['state'] in states]
    manifest = Manifest()
    sid = 'legistar-probe'
    manifest.describe(sid, 'Granicus Legistar: which county governments publish through its public API', 'https://webapi.legistar.com/Help', 'county')
    try:
        state = probe(counties, today(), everything=everything)
        manifest.ok(sid, note='%d counties found; %d tried tonight' % (len(state['clients']), sum(1 for v in state['checked'].values() if v['at'] == state.get('updated_at'))))
    except Exception as e:
        manifest.error(sid, e)
        print('   Legistar probe failed: %s' % e)
        state = writer.read_json(STATE_FILE) or {'clients': {}}
    if '--probe-only' in argv or everything:
        manifest.save()
        print('   Legistar: %d counties publish through Legistar' % len(state['clients']))
        return state
    clients = dict(load_seed())
    clients.update(state.get('clients') or {})
    geo_rows = {c['fips']: c for c in counties}
    index, upcoming, latest = collect(Http(), manifest, clients, geo_rows)
    upcoming.sort(key=lambda m: (m['date'], m.get('time') or '', m['county']))
    latest.sort(key=lambda r: (r[1], r[12], r[0]), reverse=True)
    writer.write_json('counties/index.json', {'schema_version': 1, 'counties': sorted(index, key=lambda e: (e['state'], e['county']))})
    writer.write_json('counties/upcoming.json', {'schema_version': 1, 'items': upcoming})
    writer.write_json('counties/latest.json', {'schema_version': 1, 'columns': LATEST_COLUMNS, 'rows': [r for r in latest if r[12]][:40]})
    manifest.count('us_counties_with_votes', sum(1 for e in index if e.get('coverage') == 'votes'))
    manifest.count('us_county_votes', sum((e.get('counts') or {}).get('votes', 0) for e in index))
    manifest.save()
    print('   Legistar: %d counties outside California; %d with votes' % (len(index), sum(1 for e in index if e.get('coverage') == 'votes')))
    return state


if __name__ == '__main__':
    main()
