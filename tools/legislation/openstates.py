"""
Bills and votes of every state legislature but California's, DC's council and Puerto Rico's
Legislative Assembly, from Open States' per-session bulk files (CSV format 2.1).

Open States (Plural) collects each legislature's bills, actions and roll calls from its website
and publishes one zip per session, in the public domain. The zips are public downloads, but their
addresses end in a random suffix (TX_89_csv_<random>.zip), and only the Open States API lists
them. So this step needs a free API key in OPENSTATES_API_KEY (an account at
https://open.pluralpolicy.com/accounts/profile/). Without it the step records "not configured"
and changes nothing. The key is sent only as the X-API-KEY header of one or two requests a
night (every jurisdiction with its sessions in one list), never written to a file or a log.

Sessions: the current regular session (the latest that has started and has bulk data) and any
special session since it. A session's zip is downloaded only when Open States says it changed
(updated_at). A session no longer kept is removed once the kept ones are written.

Output per state, beside the legislators from states.py:
  us-{st}/bills/{session}/index.json               bill types in the session, with their files
  us-{st}/bills/{session}/index-{TYPE}.json        one row per bill of that type
  us-{st}/bills/{session}/{TYPE}-{nn}.json         details of bills nn00 to nn99
  us-{st}/votes/{session}/{chamber}-{YYYY-MM}.json a month of one chamber's votes with each
                                                   member's position (a string in member order)
  us-{st}/votes/index.json                         sessions and the months that have votes
  us-{st}/records/{chamber}-{session}.json         each member's positions across the session
  us-{st}/summary.json                             adds the session and the latest 20 votes

Size: committee votes can be left out state by state (OPENSTATES_TRIM, or the trim rule in
sizes.py when the published records pass 800 MB); legislatures.json says where.
"""
import csv
import hashlib
import io
import os
import re
import shutil
import tempfile
import zipfile
from collections import defaultdict

from . import districts, writer
from .common import Http, Manifest, now_iso, today
from .states import short_id

API = 'https://v3.openstates.org/jurisdictions'
PER_PAGE = 52           # the API's maximum for /jurisdictions (a larger value is refused with HTTP 400)
KEY_ENV = 'OPENSTATES_API_KEY'
SID = 'openstates-bulk'
SCHEMA = 1
LATEST = 20
ACTIONS_KEPT = 25
SHARD = 100
OPTION_CODES = {'yes': 'Y', 'no': 'N', 'absent': 'X', 'excused': 'X', 'not voting': 'X', 'abstain': 'A', 'other': 'O'}
CODE_LABELS = {'Y': 'yes', 'N': 'no', 'X': 'absent, excused or not voting', 'A': 'abstain', 'O': 'other', '-': 'not on this roll'}
VOTE_COLUMNS = ['id', 'date', 'question', 'bill_id', 'bill_label', 'title', 'result', 'passed', 'yes', 'no', 'other', 'floor', 'positions', 'official_url']
INDEX_COLUMNS = ['id', 'label', 'title', 'latest_action_date', 'latest_action', 'votes']
MAX_TEXT = 400


class NotConfigured(Exception):
    pass


def jurisdiction_code(jid):
    """'ocd-jurisdiction/country:us/state:tx/government' -> 'TX' (district:dc, territory:pr too).
    A city's jurisdiction (.../state:il/place:chicago/government) is not a state's: None."""
    m = re.match(r'^ocd-jurisdiction/country:us/(?:state|district|territory):([a-z]{2})/government$', jid or '')
    return m.group(1).upper() if m else None


def fetch_sessions(http, key):
    """{state: [session, ...]} with each session's downloads, from the jurisdictions list."""
    out, page = {}, 1
    while True:
        data, _ = http.get_json(API, ttl=0, headers={'X-API-KEY': key},
                                params={'include': 'legislative_sessions', 'per_page': PER_PAGE, 'page': page})
        for j in data.get('results') or []:
            st = jurisdiction_code(j.get('id'))
            if st:
                out[st] = j.get('legislative_sessions') or []
        pages = (data.get('pagination') or {}).get('max_page') or 1
        if page >= pages:
            return out
        page += 1


def csv_download(session):
    for d in session.get('downloads') or []:
        if d.get('data_type') == 'csv' and d.get('url'):
            return d
    return None


def choose_sessions(sessions, today_s):
    """The latest regular session that has started and has bulk data, and the special sessions
    since it that have data. A new regular session with no data yet (its first weeks) leaves the
    previous one in place until Open States publishes it."""
    started = [s for s in sessions if (s.get('start_date') or '')[:10] and s['start_date'][:10] <= today_s]
    with_data = [s for s in started if csv_download(s)]
    regular = [s for s in with_data if s.get('classification') == 'primary'] or with_data
    if not regular:
        return []
    current = max(regular, key=lambda s: s['start_date'])
    chosen = [current] + [s for s in with_data if s is not current and s.get('classification') == 'special'
                          and s['start_date'] >= current['start_date']]
    return sorted(chosen, key=lambda s: s['start_date'])


def safe(sid):
    return re.sub(r'[^A-Za-z0-9_-]+', '-', str(sid)).strip('-') or 'session'


def clean(text, limit=MAX_TEXT):
    """Record text as plain text: control characters removed, spaces collapsed, length capped."""
    t = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', ' ', str(text or ''))
    t = ' '.join(t.split())
    return t if len(t) <= limit else t[:limit - 1].rstrip() + '…'


def listish(value):
    """CSV cells that hold a Python list ("['passage', 'reading-3']") -> ['passage', 'reading-3']."""
    return re.findall(r"'([^']*)'", value or '')


def bill_key(identifier):
    """'HB 18' -> ('HB', 18); 'SJR 3' -> ('SJR', 3); 'B26-0123' -> ('B', 260123)."""
    ident = (identifier or '').upper()
    m = re.match(r'^\s*([A-Z]+)\s*[-.]?\s*(\d+)\s*$', ident)
    if m:
        return m.group(1), int(m.group(2))
    letters = ''.join(re.findall(r'[A-Z]+', ident)) or 'X'
    digits = ''.join(re.findall(r'\d+', ident))
    return letters[:6], int(digits) if digits else 0


def shard_name(t, num):
    return '%s-%02d' % (t, num // SHARD)


def read_tables(zip_path):
    """{kind: [row dict, ...]} for the files in one session zip, keyed by what follows
    '{ST}_{session}_' in each file name ('bills', 'votes', 'vote_people', ...)."""
    out = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if not name.endswith('.csv'):
                continue
            parts = name.split('/')
            if len(parts) < 3:
                continue
            prefix = '%s_%s_' % (parts[0], parts[1])
            base = parts[-1]
            if not base.startswith(prefix):
                continue
            kind = base[len(prefix):-len('.csv')]
            with z.open(name) as fh:
                out[kind] = list(csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8', newline='')))
    return out


def vid_seed(v):
    return '|'.join(str(v.get(k) or '') for k in ('start_date', 'motion_text', 'bill_id', 'organization_id', 'identifier'))


def chamber_of(org_id, orgs):
    """'upper', 'lower' or 'legislature' for a chamber or one of its committees; floor is True for a chamber."""
    o = orgs.get(org_id) or {}
    cls = o.get('classification')
    if cls in ('upper', 'lower', 'legislature'):
        return cls, True
    parent = orgs.get(o.get('parent_id')) or {}
    if parent.get('classification') in ('upper', 'lower', 'legislature'):
        return parent['classification'], False
    return 'legislature', cls not in ('committee', 'subcommittee')


def build_session(st, session, export, tables, members_by_ocd, trim=False):
    """Everything for one session: (bills, votes). Pure function of the parsed tables."""
    low = st.lower()
    sid = safe(session['identifier'])
    orgs = {o['id']: o for o in tables.get('organizations') or []}
    bills = {}
    by_ocd = {}
    for b in tables.get('bills') or []:
        t, num = bill_key(b.get('identifier'))
        bid = '%s-%s-%s%d' % (low, sid, t, num)
        if bid in bills:
            bid = '%s-%s-%s%d-%s' % (low, sid, t, num, (b.get('id') or '').split('/')[-1][:6])
        bills[bid] = {'id': bid, 'label': clean(b.get('identifier'), 40), 'title': clean(b.get('title')), 'type': t, 'num': num,
                      'session': sid, 'session_name': clean(session.get('name'), 80) or sid, 'level': 'state', 'jurisdiction': 'us-%s' % low, 'state': st,
                      'chamber_of_origin': b.get('organization_classification') or None,
                      'classification': listish(b.get('classification')), 'subjects': listish(b.get('subject'))[:12],
                      'sponsors': [], 'actions': [], 'vote_ids': [], 'official_url': None}
        by_ocd[b.get('id')] = bid
    actions = defaultdict(list)
    for a in tables.get('bill_actions') or []:
        bid = by_ocd.get(a.get('bill_id'))
        if bid:
            chamber, _ = chamber_of(a.get('organization_id'), orgs)
            order = a.get('order') or '0'
            actions[bid].append((a.get('date') or '', int(order) if str(order).isdigit() else 0, clean(a.get('description'), 300), chamber))
    for bid, acts in actions.items():
        acts.sort(key=lambda x: (x[0], x[1]))
        b = bills[bid]
        b['actions_total'] = len(acts)
        b['actions'] = [{'date': d[:10], 'text': text, 'chamber': ch} for d, _, text, ch in acts[-ACTIONS_KEPT:]]
        b['introduced'] = acts[0][0][:10] or None
        b['latest_action'] = {'date': acts[-1][0][:10], 'text': acts[-1][2]}
    sponsorships = defaultdict(list)
    for sp in tables.get('bill_sponsorships') or []:
        bid = by_ocd.get(sp.get('bill_id'))
        if bid:
            sponsorships[bid].append(sp)
    known = set(members_by_ocd.values())
    for bid, sps in sponsorships.items():
        # primary sponsors first, then the others in the file's order; at most 12 are kept
        sps.sort(key=lambda sp: (sp.get('primary') or '').lower() != 'true')
        bills[bid]['sponsors_total'] = len(sps)
        for sp in sps[:12]:
            ocd = sp.get('person_id') or ''
            person = short_id(st, ocd) if ocd.startswith('ocd-person/') else None
            bills[bid]['sponsors'].append({'name': clean(sp.get('name'), 80), 'id': person if person in known else None,
                                           'primary': (sp.get('primary') or '').lower() == 'true'})
    for src in tables.get('bill_sources') or []:
        bid = by_ocd.get(src.get('bill_id'))
        if bid and not bills[bid]['official_url'] and re.match(r'^https?://', src.get('url') or ''):
            bills[bid]['official_url'] = src['url']

    people = defaultdict(list)
    for p in tables.get('vote_people') or []:
        people[p.get('vote_event_id')].append(p)
    counts = defaultdict(dict)
    for c in tables.get('vote_counts') or []:
        try:
            counts[c.get('vote_event_id')][c.get('option')] = int(c.get('value') or 0)
        except ValueError:
            pass
    vsources = {}
    for s in tables.get('vote_sources') or []:
        if s.get('vote_event_id') not in vsources and re.match(r'^https?://', s.get('url') or ''):
            vsources[s['vote_event_id']] = s['url']
    votes = []
    for v in tables.get('votes') or []:
        chamber, floor = chamber_of(v.get('organization_id'), orgs)
        if trim and not floor:
            continue
        date = (v.get('start_date') or '')[:10]
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
            continue
        uuid = re.sub(r'[^0-9a-f]', '', (v.get('id') or '').split('/')[-1])[:8]
        if len(uuid) < 8:           # ids are UUIDs; anything else gets a stable hash instead
            uuid = hashlib.sha1((v.get('id') or vid_seed(v)).encode()).hexdigest()[:8]
        vid = '%s-%s-%s-%s-%s' % (low, sid, chamber, date.replace('-', ''), uuid)
        positions = []
        for p in people.get(v.get('id')) or []:
            ocd = p.get('voter_id') or ''
            mid = short_id(st, ocd) if ocd.startswith('ocd-person/') else 'name:' + clean(p.get('voter_name'), 60)
            positions.append((mid, OPTION_CODES.get((p.get('option') or '').strip().lower(), 'O'), clean(p.get('voter_name'), 60)))
        cnt = counts.get(v.get('id')) or {}
        yes = cnt.get('yes', sum(1 for p in positions if p[1] == 'Y'))
        no = cnt.get('no', sum(1 for p in positions if p[1] == 'N'))
        other = sum(val for k, val in cnt.items() if k not in ('yes', 'no')) if cnt else sum(1 for p in positions if p[1] not in ('Y', 'N'))
        bid = by_ocd.get(v.get('bill_id'))
        result = (v.get('result') or '').strip().lower()
        votes.append({'id': vid, 'date': date, 'chamber': chamber, 'floor': floor, 'question': clean(v.get('motion_text'), 300) or 'Vote',
                      'classification': listish(v.get('motion_classification')), 'bill_id': bid,
                      'bill_label': bills[bid]['label'] if bid else None, 'title': bills[bid]['title'] if bid else '',
                      'result': result or None, 'passed': True if result == 'pass' else False if result == 'fail' else None,
                      'yes': yes, 'no': no, 'other': other, 'positions': positions, 'official_url': vsources.get(v.get('id'))})
        if bid:
            bills[bid]['vote_ids'].append(vid)
    for b in bills.values():
        b['source'] = {'id': SID, 'name': 'Open States (Plural), %s bulk data' % session.get('name', session['identifier'])}
        b['source_updated_at'] = export.get('updated_at')
    return bills, votes


def write_session(st, session, export, bills, votes, known=()):
    """Write one session's bill and vote files. Returns the index entries for us-{st}/votes/index.json.
    known: ids of the current legislators; a month file names everyone else who voted in it."""
    low = st.lower()
    sid = safe(session['identifier'])
    folder = 'us-%s/bills/%s' % (low, sid)
    by_type = defaultdict(list)
    for b in bills.values():
        by_type[b['type']].append(b)
    types = {}
    keep_bills = {'index.json'}
    for t, bs in sorted(by_type.items()):
        bs.sort(key=lambda b: (b['num'], b['id']))
        rows = [[b['id'], b['label'], b['title'][:200], (b.get('latest_action') or {}).get('date'), (b.get('latest_action') or {}).get('text', '')[:160], len(b['vote_ids'])] for b in bs]
        name = 'index-%s.json' % t
        writer.write_json('%s/%s' % (folder, name), {'schema_version': SCHEMA, 'columns': INDEX_COLUMNS, 'rows': rows})
        keep_bills.add(name)
        types[t] = {'file': name, 'bills': len(bs), 'with_votes': sum(1 for b in bs if b['vote_ids'])}
        shards = defaultdict(dict)
        for b in bs:
            shards[shard_name(t, b['num'])][b['id']] = {k: v for k, v in b.items() if k not in ('type', 'num')}
        for sh, content in shards.items():
            writer.write_json('%s/%s.json' % (folder, sh), {'schema_version': SCHEMA, 'bills': content})
            keep_bills.add(sh + '.json')
    writer.write_json('%s/index.json' % folder, {'schema_version': SCHEMA, 'state': st, 'session': sid, 'name': session.get('name'),
                                                 'types': types, 'source_updated_at': export.get('updated_at')})
    writer.remove_stale(folder, keep_bills)

    vfolder = 'us-%s/votes/%s' % (low, sid)
    months = defaultdict(list)
    for v in votes:
        months[(v['chamber'], v['date'][:7])].append(v)
    entries, keep_votes = [], set()
    for (chamber, month), vs in sorted(months.items()):
        vs.sort(key=lambda v: (v['date'], v['id']), reverse=True)
        members, names = [], {}
        for v in vs:
            for mid, _, name in v['positions']:
                if mid not in names:
                    names[mid] = name
                    members.append(mid)
        order = {m: i for i, m in enumerate(members)}
        rows = []
        for v in vs:
            pos = ['-'] * len(members)
            for mid, code, _ in v['positions']:
                pos[order[mid]] = code
            rows.append([v['id'], v['date'], v['question'], v['bill_id'], v['bill_label'], v['title'][:200], v['result'], v['passed'],
                         v['yes'], v['no'], v['other'], 1 if v['floor'] else 0, ''.join(pos), v['official_url']])
        name = '%s-%s.json' % (chamber, month)
        writer.write_json('%s/%s' % (vfolder, name), {'schema_version': SCHEMA, 'state': st, 'session': sid, 'body': 'us-%s-%s' % (low, chamber),
                                                      'members': members, 'names': {m: n for m, n in names.items() if m not in known},
                                                      'codes': CODE_LABELS, 'columns': VOTE_COLUMNS, 'rows': rows,
                                                      'source_updated_at': export.get('updated_at')})
        keep_votes.add(name)
        entries.append({'session': sid, 'body': 'us-%s-%s' % (low, chamber), 'chamber': chamber, 'month': month, 'file': name,
                        'votes': len(vs), 'floor': sum(1 for v in vs if v['floor'])})
    writer.remove_stale(vfolder, keep_votes)

    by_chamber = defaultdict(list)
    for v in votes:
        by_chamber[v['chamber']].append(v)
    for chamber, vs in by_chamber.items():
        vs.sort(key=lambda v: (v['date'], v['id']))
        members = sorted({mid for v in vs for mid, _, _ in v['positions'] if not mid.startswith('name:')})
        codes = {m: [] for m in members}
        for v in vs:
            got = {mid: code for mid, code, _ in v['positions']}
            for m in members:
                codes[m].append(got.get(m, '-'))
        writer.write_json('us-%s/records/%s-%s.json' % (low, chamber, sid), {
            'schema_version': SCHEMA, 'session': sid, 'body': 'us-%s-%s' % (low, chamber), 'votes': [v['id'] for v in vs],
            'floor': [1 if v['floor'] else 0 for v in vs], 'members': {m: ''.join(c) for m, c in codes.items()}, 'codes': CODE_LABELS})
    return entries


def download(http, url, dest):
    """Stream a session zip to dest (not cached: the zips run to tens of megabytes)."""
    import requests
    with requests.get(url, stream=True, timeout=120, headers={'User-Agent': http.session.headers.get('User-Agent', '')}) as r:
        if r.status_code != 200:
            raise RuntimeError('HTTP %s for %s' % (r.status_code, url))
        with open(dest, 'wb') as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)


def trimmed_states():
    """States whose committee votes are left out: OPENSTATES_TRIM=TX,NY or the size rule's list."""
    env = [s.strip().upper() for s in os.environ.get('OPENSTATES_TRIM', '').split(',') if s.strip()]
    rule = (writer.read_json('sizes.json') or {}).get('trim') or []
    return set(env) | set(rule)


def members_index(st):
    d = writer.read_json('us-%s/members.json' % st.lower()) or {}
    return {m['ocd_id']: m['id'] for m in d.get('members') or [] if m.get('ocd_id')}


def run_state(http, st, sessions, today_s, trim, fetch=None):
    """Refresh one state. Returns (status, note) and writes its files. fetch(url, dest) downloads a zip."""
    low = st.lower()
    state_file = 'us-%s/openstates.json' % low
    seen = writer.read_json(state_file) or {'sessions': {}}
    chosen = choose_sessions(sessions, today_s)
    if not chosen:
        return 'none', 'no session with bulk data'
    members = members_index(st)
    index = writer.read_json('us-%s/votes/index.json' % low) or {'sessions': [], 'shards': []}
    changed = 0
    latest_rows = []
    kept_sessions = []
    for s in chosen:
        sid = safe(s['identifier'])
        export = csv_download(s)
        prev = seen['sessions'].get(sid) or {}
        kept_sessions.append({'id': sid, 'name': s.get('name'), 'classification': s.get('classification'),
                              'start': s.get('start_date'), 'end': s.get('end_date'), 'updated_at': export.get('updated_at')})
        if prev.get('updated_at') == export.get('updated_at') and prev.get('trim') == (st in trim) and writer.read_json('us-%s/bills/%s/index.json' % (low, sid)):
            continue
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'session.zip')
            (fetch or (lambda u, d: download(http, u, d)))(export['url'], path)
            tables = read_tables(path)
        bills, votes = build_session(st, s, export, tables, members, trim=st in trim)
        entries = write_session(st, s, export, bills, votes, known=set(members.values()))
        index['shards'] = [e for e in index.get('shards') or [] if e['session'] != sid] + entries
        seen['sessions'][sid] = {'updated_at': export.get('updated_at'), 'bills': len(bills), 'votes': len(votes), 'floor': sum(1 for v in votes if v['floor']),
                                 'trim': st in trim, 'checked_at': now_iso()}
        changed += 1
    chosen_ids = {k['id'] for k in kept_sessions}
    index['shards'] = sorted([e for e in index.get('shards') or [] if e['session'] in chosen_ids], key=lambda e: (e['session'], e['body'], e['month']))
    index.update({'schema_version': SCHEMA, 'state': st, 'sessions': kept_sessions, 'columns': VOTE_COLUMNS})
    writer.write_json('us-%s/votes/index.json' % low, index)
    seen['sessions'] = {k: v for k, v in seen['sessions'].items() if k in chosen_ids}
    writer.write_json(state_file, seen)
    # Sessions no longer kept (a new regular session has started) are removed, but only once every
    # kept session's files are in place, so a bad night never leaves a state with nothing.
    if all(writer.read_json('us-%s/bills/%s/index.json' % (low, k)) for k in chosen_ids):
        for kind in ('bills', 'votes'):
            root = writer.path('us-%s/%s' % (low, kind))
            for name in (os.listdir(root) if os.path.isdir(root) else []):
                if name not in chosen_ids and os.path.isdir(os.path.join(root, name)):
                    shutil.rmtree(os.path.join(root, name))
        writer.remove_stale('us-%s/records' % low, {'%s-%s.json' % (ch, k) for k in chosen_ids for ch in ('upper', 'lower', 'legislature')})
    # the latest votes across the chosen sessions, for the state page
    for e in sorted(index['shards'], key=lambda e: e['month'], reverse=True)[:6]:
        d = writer.read_json('us-%s/votes/%s/%s' % (low, e['session'], e['file'])) or {}
        latest_rows += [dict(zip(d.get('columns') or [], r), body=e['body']) for r in d.get('rows') or []]
    latest_rows.sort(key=lambda v: (v['date'], v['id']), reverse=True)
    summ = writer.read_json('us-%s/summary.json' % low)
    if summ:
        current = kept_sessions[0] if len(kept_sessions) == 1 else max(kept_sessions, key=lambda k: k['start'] or '')
        summ['session'] = {'id': current['id'], 'name': current['name'], 'start': current['start'], 'end': current['end'],
                           'sessions': [{'id': k['id'], 'name': k['name']} for k in kept_sessions]}
        summ['latest'] = [{k: v[k] for k in ('id', 'date', 'question', 'bill_id', 'bill_label', 'title', 'result', 'passed', 'yes', 'no', 'other', 'floor', 'body')}
                          for v in latest_rows[:LATEST]]
        summ['votes_source'] = {'id': SID, 'name': 'Open States (Plural), bulk data', 'official': False,
                                'committee_votes': 'left out' if st in trim else 'kept',
                                'updated_at': max((k['updated_at'] or '' for k in kept_sessions), default=None) or None}
        writer.write_json('us-%s/summary.json' % low, summ)
    total_votes = sum(v['votes'] for v in seen['sessions'].values())
    return 'ok', '%d sessions (%d refreshed), %d votes' % (len(kept_sessions), changed, total_votes)


def main(argv=None):
    manifest = Manifest()
    manifest.describe(SID, 'Open States (Plural): bills and votes of every other state, bulk data', 'https://open.pluralpolicy.com/data/session-csv/',
                      'state', official=False, license='Public domain')
    key = os.environ.get(KEY_ENV, '').strip()
    if not key:
        manifest.source(SID).update({'status': 'not_configured', 'last_checked_at': now_iso(),
                                     'note': 'Needs a free Open States API key in the %s secret' % KEY_ENV})
        manifest.save()
        print('   Open States bulk data: not configured (%s is not set)' % KEY_ENV)
        return
    http = Http()
    try:
        by_state = fetch_sessions(http, key)
    except Exception as e:
        manifest.error(SID, str(e).replace(key, '[key]'))
        manifest.save()
        print('   Open States API unavailable: %s' % str(e).replace(key, '[key]'))
        return
    only = [s.strip().upper() for s in os.environ.get('LEGIS_STATES', '').split(',') if s.strip()]
    trim = trimmed_states()
    today_s = today().isoformat()
    ok, failed, leg = [], [], writer.read_json('legislatures.json') or {'states': {}}
    for st in sorted(districts.STATES):
        if st == 'CA' or (only and st not in only):
            continue
        try:
            status, note = run_state(http, st, by_state.get(st) or [], today_s, trim)
        except Exception as e:
            failed.append('%s (%s)' % (st, str(e).replace(key, '[key]')[:80]))
            print('   %s: %s' % (st, str(e).replace(key, '[key]')))
            continue
        ok.append(st)
        row = leg['states'].setdefault(st, {})
        seen = (writer.read_json('us-%s/openstates.json' % st.lower()) or {}).get('sessions') or {}
        row['votes'] = sum(v.get('votes', 0) for v in seen.values())
        row['bills'] = sum(v.get('bills', 0) for v in seen.values())
        row['committee_votes'] = 'left out' if st in trim else 'kept'
        print('   %s: %s' % (st, note))
    writer.write_json('legislatures.json', leg)
    note = '%d legislatures' % len(ok)
    if failed and ok:
        manifest.partial(SID, 'failed: ' + ', '.join(failed), note=note)
    elif failed:
        manifest.error(SID, 'failed: ' + ', '.join(failed))
    else:
        manifest.ok(SID, note=note)
    if not only:
        sessions = sorted('%s:%s' % (s, k) for s in ok for k in ((writer.read_json('us-%s/openstates.json' % s.lower()) or {}).get('sessions') or {}))
        manifest.count('st_votes', sum((leg['states'].get(s) or {}).get('votes', 0) for s in ok),
                       scope=hashlib.sha1(' '.join(sessions).encode()).hexdigest()[:12])
    manifest.save()


if __name__ == '__main__':
    main()
