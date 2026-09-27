"""
Integrity checks for data/legislation/. Returns a list of failure strings.

- manifest.json parses and every source has a status
- every vote index row points at a vote file; every vote file's positions reference known members or provisional ids
- every bill referenced by a vote exists in the bill index
- shrink guard: a count that only grows during a Congress or a session may not fall by more than
  20 percent from one night to the next (a feed returning an empty page must not wipe the site's
  data), unless ALLOW_SHRINK=1. A new Congress or session starts its counts again, so the guard
  skips a count whose scope changed. Rolling 90-day county counts may move with the boards'
  calendars and only fail if they halve. Upcoming counts are not guarded: a recess empties them.
"""
import os

from . import writer

# count key -> the lowest share of last night's value that still passes
SHRINK_LIMITS = {
    'us_members': 0.8, 'us_votes': 0.8, 'us_bills': 0.8,
    'ca_members': 0.8, 'ca_bills': 0.8, 'ca_votes': 0.8, 'ca_counties': 0.8,
    'ca_county_votes': 0.5, 'ca_county_meetings': 0.5,
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
    failures += shrink_failures(manifest)
    return failures
