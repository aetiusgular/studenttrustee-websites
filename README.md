# studenttrustee.net legislation records

This branch holds the records behind https://studenttrustee.net/legislation/. GitHub Pages
serves it at https://nbonasera.github.io/studenttrustee-websites/, and the site reads from there.

The nightly workflow on `main` (`.github/workflows/data-refresh.yml`) rebuilds these files from
official sources and replaces this branch with a single commit. There is no history here on
purpose, and hand edits are overwritten the next night. Change the pipeline in
`tools/legislation/` on `main` instead.

- `manifest.json`: every source, when it was last checked, whether that check worked, when the
  source itself last changed, and record counts.
- `us/`: Congress (members, roll-call votes, bills with votes, voting records, schedule).
- `us-ca/`: the California Legislature and the 58 county boards of supervisors.
- `geo/`: states, California counties, and which districts overlap each county.
- `search/`: search indexes.

Where each source comes from: https://studenttrustee.net/legislation/sources/
