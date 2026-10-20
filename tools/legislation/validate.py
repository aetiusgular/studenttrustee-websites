#!/usr/bin/env python3
"""
Validate the committed data files before they are pushed.

    python3 -m tools.legislation.validate

Checks the district boundary snapshot today; the legislation manifest and
its shards are checked as they are added (see the checks list below).
Exit 1 on any failure so the workflow's commit step never runs on bad data.
"""
import os
import sys


def main(argv=None):
    failures = []
    from . import boundaries
    try:
        boundaries.main(['--check'])
    except SystemExit as e:
        if e.code not in (0, None):
            failures.append('boundaries: %s' % e.code)
    try:
        from . import legislation_checks
    except ImportError:
        legislation_checks = None
    if legislation_checks:
        failures += legislation_checks.run()
    if failures:
        print('VALIDATION FAILED\n  ' + '\n  '.join(str(f) for f in failures))
        if os.environ.get('GITHUB_ACTIONS'):
            # Annotations show on the run's public summary page and in the checks API, where the
            # full log (which needs a signed-in viewer) does not.
            for f in failures[:20]:
                print('::error title=Validation failed::%s' % str(f).replace('\n', ' ')[:500])
            if len(failures) > 20:
                print('::error title=Validation failed::%d more failures in the log' % (len(failures) - 20))
        sys.exit(1)
    print('validation passed')


if __name__ == '__main__':
    main()
