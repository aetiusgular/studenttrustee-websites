"""
Integrity checks for data/legislation/. Returns a list of failure strings.

- manifest.json parses and every source has a status
- every vote index row points at a vote file; every vote file's positions reference known members or provisional ids
- every bill referenced by a vote exists in the bill index
- every state's county file: each county in exactly one state, the district keys it names are in
  that state's district table, board links are http(s); every state's legislators: unique ids,
  district keys the county files know, search rows that point at real legislators
- every county board outside California: its record exists and its ids carry its county's prefix
- shrink guard: a count that only grows during a Congress or a session may not fall by more than
  20 percent from one night to the next (a feed returning an empty page must not wipe the site's
  data), unless ALLOW_SHRINK=1. A new Congress or session starts its counts again, so the guard
  skips a count whose scope changed. Rolling 90-day county counts may move with the boards'
  calendars and only fail if they halve. Upcoming counts are not guarded: a recess empties them.
"""
import os
import re

from . import writer

# count key -> the lowest share of last night's value that still passes
SHRINK_LIMITS = {
    'us_members': 0.8, 'us_votes': 0.8, 'us_bills': 0.8,
    'ca_members': 0.8, 'ca_bills': 0.8, 'ca_votes': 0.8, 'ca_counties': 0.8,
    'ca_county_votes': 0.5, 'ca_county_meetings': 0.5,
    'us_counties': 0.95, 'st_members': 0.8,
    'us_county_votes': 0.5, 'st_votes': 0.8,
}


def shrink_failures(manifest):
    if os.environ.get('ALLOW_SHRINK'):
        return []
    failures = []
    prev = manifest.get('previous_counts') or {}
    counts = manifest.get('counts') or {}
    prev_scopes = manifest.get('previous_count_scopes') or {}
    scopes = manifest.get('count_scopes') or {}
    for key, limit in SHRINK_LIMITS.items():
        old, new = prev.get(key), counts.get(key)
        if not (isinstance(old, int) and isinstance(new, int)) or old <= 20:
            continue
        if key in prev_scopes and key in scopes and prev_scopes[key] != scopes[key]:
            continue   # a new Congress or session: the count starts again
        if new < old * limit:
            failures.append('%s shrank from %d to %d (set ALLOW_SHRINK=1 if this is expected)' % (key, old, new))
    return failures


def _load(rel):
    return writer.read_json(rel)


def california_checks():
    """Every CA vote index row has its vote in the per-bill file, every position names a known
    member (or a provisional ca-name- id), and every bill a vote points at is in the bill index."""
    failures = []
    members = _load('us-ca/members.json')
    if members is None:
        return failures
    member_ids = {m['id'] for m in members.get('members', [])}
    votes_dir = writer.path('us-ca/votes')
    if not os.path.isdir(votes_dir):
        return ['us-ca/members.json exists but us-ca/votes/ does not']
    bill_index = {}
    per_bill_cache = {}
    unknown_total = 0
    for name in sorted(os.listdir(votes_dir)):
        if not name.endswith('.json') or name == 'index.json':
            continue
        session = name.split('-')[0]
        if session not in bill_index:
            idx = _load('us-ca/bills/%s/index.json' % session) or {}
            ids = set()
            for t in idx.get('types', {}).values():
                ids.update(r[0] for r in (_load('us-ca/bills/%s/%s' % (session, t['file'])) or {}).get('rows', []))
            bill_index[session] = ids
        shard = _load('us-ca/votes/' + name) or {}
        cols = shard.get('columns') or []
        if 'id' not in cols or 'bill_id' not in cols:
            failures.append('CA vote shard %s has no id/bill_id columns' % name)
            continue
        for row in shard.get('rows', []):
            vid, bill_id = row[cols.index('id')], row[cols.index('bill_id')]
            key = (session, bill_id)
            if key not in per_bill_cache:
                per_bill_cache[key] = {v['id']: v for v in (_load('us-ca/votes/%s/%s.json' % key) or {}).get('votes', [])}
            vote = per_bill_cache[key].get(vid)
            if not vote:
                failures.append('CA vote index %s references %s, missing from votes/%s/%s.json' % (name, vid, session, bill_id))
                continue
            unknown = [p[0] for p in vote.get('positions', []) if p[0] not in member_ids and not p[0].startswith('ca-name-')]
            unknown_total += len(unknown)
            if unknown and len(failures) < 50:
                failures.append('CA vote %s has %d positions for unknown members (e.g. %s)' % (vid, len(unknown), unknown[0]))
            if bill_id not in bill_index[session]:
                failures.append('CA vote %s references bill %s missing from the %s index' % (vid, bill_id, session))
    if unknown_total:
        failures.append('CA: %d positions in total name unknown members' % unknown_total)
    return failures


def national_checks():
    failures = []
    states = (_load('geo/states.json') or {}).get('states') or []
    seen_fips, seen_ids = {}, set()
    for s in states:
        st = s['code']
        if st == 'CA' or 'legislature' not in s or not s.get('counties'):
            continue
        low = st.lower()
        geo = _load('geo/us-%s/counties.json' % low)
        if geo is None:
            failures.append('geo/states.json lists %d counties for %s but geo/us-%s/counties.json is missing' % (s['counties'], st, low))
            continue
        counties = geo.get('counties') or []
        if len(counties) != s['counties']:
            failures.append('%s: geo/states.json says %d counties, the county file has %d' % (st, s['counties'], len(counties)))
        tables = geo.get('districts') or {}
        slugs = set()
        for c in counties:
            fips = c.get('fips') or ''
            if fips in seen_fips:
                failures.append('county %s is in both %s and %s' % (fips, seen_fips[fips], st))
            seen_fips[fips] = st
            if fips[:2] != s['fips']:
                failures.append('%s: county %s does not start with the state code %s' % (st, fips, s['fips']))
            if c.get('slug') in slugs:
                failures.append('%s: two counties share the slug %s' % (st, c.get('slug')))
            slugs.add(c.get('slug'))
            for chamber, col in (('upper', 'sldu'), ('lower', 'sldl')):
                missing = [k for k in c.get(col) or [] if k not in (tables.get(chamber) or {})]
                if missing:
                    failures.append('%s: %s names %s districts %s that are not in the district table' % (st, c.get('name'), chamber, missing[:3]))
            url = (c.get('board') or {}).get('url')
            if url and not url.startswith(('https://', 'http://')):
                failures.append('%s: board link for %s is not http(s): %s' % (st, c.get('name'), url[:60]))
        members = _load('us-%s/members.json' % low)
        if members is None:
            continue
        ids = set()
        for m in members.get('members') or []:
            if m['id'] in seen_ids:
                failures.append('legislator id %s is used twice' % m['id'])
            seen_ids.add(m['id'])
            ids.add(m['id'])
            if m.get('chamber') not in ('upper', 'lower', 'legislature'):
                failures.append('%s: %s has chamber %r' % (st, m['id'], m.get('chamber')))
            table = tables.get('upper' if m.get('chamber') in ('upper', 'legislature') else 'lower') or {}
            if m.get('district_key') and m['district_key'] not in table:
                failures.append('%s: %s has district key %s, not in the county file' % (st, m['id'], m['district_key']))
    search = _load('search/states.json')
    if search is not None:
        stray = [r[1] for r in search.get('rows') or [] if r[0] == 'member' and r[1] not in seen_ids]
        if stray:
            failures.append('search/states.json lists %d legislators not in any members file (e.g. %s)' % (len(stray), stray[0]))
    return failures[:200]


def county_board_checks():
    """Every county board outside California in counties/index.json has its board.json, and every
    vote and member in it carries that county's id prefix."""
    failures = []
    idx = _load('counties/index.json')
    for e in (idx or {}).get('counties') or []:
        folder = 'us-%s/counties/%s' % (e['state'].lower(), e['fips'])
        board = _load(folder + '/board.json')
        if board is None:
            failures.append('counties/index.json lists %s but %s/board.json is missing' % (e['fips'], folder))
            continue
        prefix = '%s-%s-bos' % (e['state'].lower(), e['fips'])
        bad = [m['id'] for m in board.get('members') or [] if not m['id'].startswith(prefix)]
        for mo in board.get('vote_months') or []:
            month = _load('%s/%s' % (folder, mo['file'])) or {}
            bad += [r[0] for r in month.get('rows') or [] if not r[0].startswith(prefix + '-vote-')]
            if len(month.get('members') or []) and any(len(r[11]) != len(month['members']) for r in month.get('rows') or []):
                failures.append('%s/%s: a positions string does not match the member list' % (folder, mo['file']))
        if bad:
            failures.append('%s: %d ids without the prefix %s (e.g. %s)' % (folder, len(bad), prefix, bad[0]))
    return failures


# The shapes the page reads ids with (legislation.js stateBillFile and stateVoteFile).
STATE_BILL_ID = re.compile(r'^([a-z]{2})-([A-Za-z0-9_-]+)-([A-Z]+)(\d+)(-[0-9a-z]+)?$')
STATE_VOTE_ID = re.compile(r'^([a-z]{2})-([A-Za-z0-9_-]+)-(upper|lower|legislature)-(\d{4})(\d{2})\d{2}-([0-9a-f]{8})$')


def state_vote_checks():
    """Other states' bills and votes (openstates.py). The page finds a record's file from its id
    alone, so every id must lead to the file that holds it, and every positions string must match
    its file's member list."""
    failures = []
    root = writer.path('')
    if not os.path.isdir(root):
        return failures
    for d in sorted(os.listdir(root)):
        if not (d.startswith('us-') and len(d) == 5) or d == 'us-ca':
            continue
        st = d[3:]
        idx = _load(d + '/votes/index.json')
        for e in (idx or {}).get('shards') or []:
            rel = '%s/votes/%s/%s' % (d, e['session'], e['file'])
            month = _load(rel)
            if month is None:
                failures.append('%s/votes/index.json lists %s, which is missing' % (d, rel))
                continue
            cols = month.get('columns') or []
            n = len(month.get('members') or [])
            for r in month.get('rows') or []:
                row = dict(zip(cols, r))
                m = STATE_VOTE_ID.match(row.get('id') or '')
                if not m or 'us-%s/votes/%s/%s-%s-%s.json' % m.group(1, 2, 3, 4, 5) != rel:
                    failures.append('%s: vote id %s does not lead to this file' % (rel, row.get('id')))
                    break
                if row.get('positions') and len(row['positions']) != n:
                    failures.append('%s: a positions string does not match the member list' % rel)
                    break
                if row.get('bill_id') and not STATE_BILL_ID.match(row['bill_id']):
                    failures.append('%s: bill id %s has the wrong shape' % (rel, row['bill_id']))
                    break
        bills = writer.path(d + '/bills')
        if not os.path.isdir(bills):
            continue
        for sess in sorted(os.listdir(bills)):
            folder = '%s/bills/%s' % (d, sess)
            if not os.path.isdir(writer.path(folder)):
                continue
            for name in sorted(os.listdir(writer.path(folder))):
                if name.startswith('index') or not name.endswith('.json'):
                    continue
                for bid, b in ((_load('%s/%s' % (folder, name)) or {}).get('bills') or {}).items():
                    m = STATE_BILL_ID.match(bid)
                    if not m or (m.group(1), m.group(2), '%s-%02d.json' % (m.group(3), int(m.group(4)) // 100)) != (st, sess, name):
                        failures.append('%s/%s: bill id %s does not lead to this file' % (folder, name, bid))
                        break
                    bad = [v for v in b.get('vote_ids') or [] if not STATE_VOTE_ID.match(v)]
                    if bad:
                        failures.append('%s/%s: %s has a vote id of the wrong shape (%s)' % (folder, name, bid, bad[0]))
                        break
    return failures[:200]


def size_failures():
    """GitHub Pages refuses a site over 1 GB; the records must stay under 950 MB (sizes.py trims at 800)."""
    from . import sizes
    total, folders, _ = sizes.measure()
    if total > sizes.FAIL_AT:
        biggest = sorted(folders.items(), key=lambda kv: -kv[1])[:5]
        return ['the records are %.0f MB, over the %d MB limit (largest: %s)' % (total / 1e6, sizes.FAIL_AT // 10 ** 6,
                ', '.join('%s %.0f MB' % (k, v / 1e6) for k, v in biggest))]
    return []


def run():
    failures = []
    manifest = _load('manifest.json')
    if manifest is None:
        print('   no legislation manifest yet (pipeline has not run); skipping legislation checks')
        return []
    if not isinstance(manifest, dict):
        return ['manifest.json is not a JSON object']
    for sid, s in manifest.get('sources', {}).items():
        if not s.get('status'):
            failures.append('source %s has no status' % sid)
    members = _load('us/members.json')
    member_ids = {m['id'] for m in (members or {}).get('members', [])}
    votes_dir = writer.path('us/votes')
    if os.path.isdir(votes_dir):
        for name in sorted(os.listdir(votes_dir)):
            if not name.endswith('.json') or name.startswith('us-'):
                continue
            idx = _load('us/votes/' + name)
            for row in idx.get('rows', []):
                vote = _load('us/votes/%s.json' % row[0])
                if not vote:
                    failures.append('vote index %s references missing %s' % (name, row[0])); continue
                unknown = [p[0] for p in vote.get('positions', []) if p[0] not in member_ids and not p[0].startswith('lis-')]
                if unknown:
                    failures.append('vote %s has %d positions for unknown members (e.g. %s)' % (row[0], len(unknown), unknown[0]))
                if row[11]:
                    congress = vote.get('congress')
                    if not _load('us/bills/%s/%s.json' % (congress, row[11])):
                        failures.append('vote %s references missing bill %s' % (row[0], row[11]))
    failures += california_checks()
    failures += national_checks()
    failures += county_board_checks()
    failures += state_vote_checks()
    failures += size_failures()
    failures += shrink_failures(manifest)
    return failures
