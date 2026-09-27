"""
Integrity checks for data/legislation/. Returns a list of failure strings.

- manifest.json parses and every source has a status
- every vote index row points at a vote file; every vote file's positions reference known members or provisional ids
- every bill referenced by a vote exists in the bill index
- shrink guard: no index lost more than 20 percent of its rows since the last run (a feed returning
  an empty page must not wipe the site's data), unless ALLOW_SHRINK=1
"""
import json
import os

from . import writer


def _load(rel):
    return writer.read_json(rel)


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
    # shrink guard against the previous manifest counts
    prev = manifest.get('previous_counts') or {}
    for key, old in prev.items():
        new = manifest.get('counts', {}).get(key)
        if isinstance(old, int) and isinstance(new, int) and old > 20 and new < old * 0.8 and not os.environ.get('ALLOW_SHRINK'):
            failures.append('%s shrank from %d to %d (set ALLOW_SHRINK=1 if this is expected)' % (key, old, new))
    return failures
