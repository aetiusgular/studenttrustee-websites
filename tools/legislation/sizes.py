"""
How big the published records are, and the rule that keeps them under GitHub Pages' 1 GB limit.

Runs last each night. It measures every file under data/legislation, in total and per state,
and writes sizes.json. When the total passes 800 MB, the states whose votes take the most space
(California aside) are put on the trim list, largest first, until leaving out their committee
votes would bring the total under 800 MB. The next night's openstates step rebuilds those states
with floor votes only, and their pages say so. A state stays on the list until someone removes it
from sizes.json (or runs with OPENSTATES_TRIM set), so the list does not flap from night to
night. The validator fails a night whose records pass 950 MB.
"""
import os

from . import writer
from .common import Manifest, now_iso

TRIM_AT = 800 * 1000 * 1000
FAIL_AT = 950 * 1000 * 1000


def measure(root=None):
    """(total bytes, {folder: bytes}, {state: vote and record bytes}) for the published records."""
    root = root or writer.path('')
    total, folders, votes = 0, {}, {}
    for dirpath, _, files in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if rel.startswith('.git'):
            continue
        top = rel.split(os.sep)[0] if rel != '.' else '.'
        for f in files:
            try:
                n = os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                continue
            total += n
            folders[top] = folders.get(top, 0) + n
            parts = rel.split(os.sep)
            if len(parts) >= 2 and parts[0].startswith('us-') and len(parts[0]) == 5 and parts[1] in ('votes', 'records'):
                st = parts[0][3:].upper()
                votes[st] = votes.get(st, 0) + n
    return total, folders, votes


def committee_share(st):
    """The share of a state's collected votes taken in committee, from the openstates step's log."""
    seen = (writer.read_json('us-%s/openstates.json' % st.lower()) or {}).get('sessions') or {}
    total = sum(v.get('votes', 0) for v in seen.values())
    floor = sum(v.get('floor', v.get('votes', 0)) for v in seen.values())
    return (total - floor) / total if total else 0.0


def plan_trim(total, votes, already, share=committee_share):
    """States to add to the trim list so the total drops under TRIM_AT."""
    add = []
    projected = total
    for st, n in sorted(votes.items(), key=lambda kv: -kv[1]):
        if projected <= TRIM_AT:
            break
        if st == 'CA' or st in already:
            continue
        saving = n * share(st)
        if saving <= 0:
            continue
        add.append(st)
        projected -= saving
    return add, projected


def main(argv=None):
    total, folders, votes = measure()
    prev = writer.read_json('sizes.json') or {}
    trim = list(prev.get('trim') or [])
    projected = total
    if total > TRIM_AT:
        add, projected = plan_trim(total, votes, set(trim))
        trim += add
        if add:
            print('   over %d MB: committee votes will be left out for %s' % (TRIM_AT // 10 ** 6, ', '.join(add)))
    writer.write_json('sizes.json', {'schema_version': 1, 'measured_at': now_iso(), 'total_bytes': total, 'projected_bytes': projected,
                                     'folders': dict(sorted(folders.items())), 'state_votes': dict(sorted(votes.items())), 'trim': sorted(trim)})
    manifest = Manifest()
    manifest.data['size_bytes'] = total
    manifest.save()
    print('   published records: %.1f MB (limit %d MB, trim above %d MB)' % (total / 1e6, FAIL_AT // 10 ** 6, TRIM_AT // 10 ** 6))


if __name__ == '__main__':
    main()
