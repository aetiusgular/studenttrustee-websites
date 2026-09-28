#!/usr/bin/env python3
"""
Entry point for the nightly data refresh.

    python3 -m tools.legislation.refresh all
    python3 -m tools.legislation.refresh boundaries federal

Each target is independent: a failure in one is logged, recorded in the
manifest as an error, and does not stop the others. Yesterday's files for a
failed source are left in place, so the site never loses data because a feed
was down for a night.
"""
import sys
import traceback

TARGETS = ['boundaries', 'geo', 'federal', 'california', 'counties', 'states']


def run_boundaries():
    from . import boundaries
    boundaries.main([])


def run_target(name):
    if name == 'boundaries':
        return run_boundaries()
    mod = __import__('tools.legislation.' + name, fromlist=['main'])
    return mod.main([])


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv == ['all']:
        wanted = TARGETS
    else:
        wanted = [a for a in argv if a in TARGETS]
        unknown = [a for a in argv if a not in TARGETS]
        if unknown:
            sys.exit('unknown target(s): %s (valid: %s)' % (', '.join(unknown), ', '.join(TARGETS)))
    failures = []
    for name in wanted:
        print('== %s ==' % name, flush=True)
        try:
            run_target(name)
        except Exception:
            failures.append(name)
            traceback.print_exc()
    if failures:
        print('targets with errors: %s' % ', '.join(failures))
        # Exit 0 on purpose: partial refreshes still get committed; the manifest carries the error state.
    print('done')


if __name__ == '__main__':
    main()
