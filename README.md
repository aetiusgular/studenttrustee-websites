# studenttrustee.net

Two static sites, one repo, plus a nightly job that collects legislative records.

```
studenttrustee/ -> studenttrustee.net            (Netlify, deploys from main)
volunteer/      -> volunteer.studenttrustee.net  (Netlify, deploys from main)
data branch     -> the Legislation section's records (GitHub Pages, updated nightly)
```

## Deploying

Each folder is its own Netlify site. In Netlify, for each one:

| Setting           | studenttrustee.net | volunteer.studenttrustee.net |
|-------------------|--------------------|------------------------------|
| Base directory    | `studenttrustee`   | `volunteer`                  |
| Build command     | *(leave empty)*    | *(leave empty)*              |
| Publish directory | `studenttrustee`   | `volunteer`                  |

Pushing to `main` deploys. The pages are rendered ahead of time and committed, so Netlify has
nothing to build.

### One-time setup for the Legislation section

The records do not live on `main`. They live on the `data` branch, which GitHub Pages serves, and
the nightly workflow replaces that branch every night. This keeps nightly updates from being Netlify
deploys: on Netlify's credit-based Free plan (accounts created on or after 4 September 2025) every
production deploy costs 15 of the plan's 300 monthly credits, and when the credits run out Netlify
pauses every site on the account. Thirty nightly deploys would do that. GitHub Pages costs nothing
for a public repository.

Someone with admin rights on the GitHub repository does this once:

1. Push the `data` branch (`git push origin data`).
2. Settings > Pages > Build and deployment: Source **Deploy from a branch**, Branch **data**, folder
   **/ (root)**. Save. The records then appear at `https://nbonasera.github.io/studenttrustee-websites/`.
3. Settings > Actions > General > Workflow permissions: **Read and write permissions**, so the nightly
   job can push the `data` branch.
4. Optional: Settings > Secrets and variables > Actions > New repository secret `CONGRESS_API_KEY`
   (free key from https://api.congress.gov/sign-up/). Without it, federal bills show the titles and
   actions recorded in the roll calls; with it, they also get sponsors, policy area and summaries.

If the Pages address ever changes (a custom domain, or a renamed repository), update
`legislation_data_url` in `studenttrustee/data/site.json` and the `connect-src` entry of the
Content-Security-Policy in `studenttrustee/_headers`. The build refuses to run if the two disagree.

## What is here

**studenttrustee/**: the landing page, the 72-district map, the district pages, the Legislation
section, the legislative calendars, the accessibility statement and About. Every HTML file is
rendered by `tools/build.py` from the Jinja2 templates in `tools/templates/` and the data in
`studenttrustee/data/` (`roster.json` is the trustee roster, `site.json` the verification dates
and the records address). Edit a template or the data, run `python3 tools/build.py`, commit the
output. CI fails if the committed pages are stale. Shared styles live in `assets/site.css` (tokens
meet WCAG AAA contrast), page styles in `assets/<page>.css`, scripts in `assets/<page>.js`. Leaflet
is vendored under `vendor/leaflet-1.9.4/`.

The map reads district boundaries from `data/districts.geojson`, a simplified snapshot of the
Foundation for California Community Colleges GIS layer (311 KB instead of an ArcGIS query that took
2.5 to 3.5 seconds per visit). The nightly job checks the layer's last-edit date and rebuilds the
snapshot only when the source has changed, which then lands on `main` as a normal commit.

**The Legislation section** (`/legislation/`) is one page, `legislation/index.html`, with a small
router in `assets/legislation.js`. Netlify's `_redirects` sends every `/legislation/...` address to
it; `/legislature` redirects to `/legislation/calendars/`. It covers:

| Level   | Where it comes from                                                                 | What is shown |
|---------|--------------------------------------------------------------------------------------|---------------|
| Federal | Clerk of the House roll-call XML, Senate LIS vote XML, docs.house.gov Bills This Week, senate.gov hearings and floor schedule, congress-legislators (CC0) for member identity | every roll call of the current Congress with each member's position, bills with votes, members' records, what is scheduled |
| State (California) | The Legislature's nightly database export (LegInfo pubinfo, about 1.1 GB) | every bill of the session, every floor and committee vote with positions, legislators' records, the Daily File and committee hearings |
| County (California) | Granicus Legistar public API for the counties that use it; the official board pages for the rest | meetings, agenda actions and each supervisor's vote for the last 90 days where published; links and a nightly reachability check everywhere else |

Other states have their congressional delegations and federal votes; their legislatures are not
collected. Which districts overlap each county comes from the Census Bureau's 2024 relationship
files and, for the congressional map in force from 3 January 2027, the AB 604 block equivalency file.

Every record carries `source_updated_at` (when the source last changed it), and
`manifest.json` records, for every source, when it was last checked, whether that check worked,
and the counts. The site shows both.

**tools/legislation/**: the pipeline. `refresh.py` runs the targets (`boundaries geo federal
california counties`); each is independent, and a failure keeps the previous night's files for that
source and marks it stale in the manifest. `validate.py` then checks that every index row points at
a real record, every position names a known member, and that no index shrank by more than 20 percent
since the night before (a broken feed must not wipe the site's data). The workflow publishes only if
validation passes.

**volunteer/**: the Bay Area volunteer directory. `data.js` holds all 262 organizations;
`index.html` is the whole interface.

**brand/**: shared identity. The `-p6` suffix on icon files is a cache-busting version.

## Developing

```
npm install                                   # lint and test tooling (Node 20+)
python3 -m pip install -r requirements.txt    # template build and data pipeline (Python 3.11+)
sh tools/pull-data.sh                         # copy the published records into studenttrustee/data/legislation/
npm run serve                                 # http://127.0.0.1:8100 (and the volunteer site on 8101)
```

On `localhost` the Legislation section reads the records from `studenttrustee/data/legislation/`;
everywhere else it reads them from GitHub Pages.

To regenerate records instead of pulling them: `python3 -m tools.legislation.refresh federal`
(or `california`, `counties`, `geo`, `all`). California downloads the 1.1 GB export; set
`PUBINFO_ZIP=/path/to/pubinfo_daily_Sat.zip` to reuse one you already have. `LEGIS_LIMIT=5` keeps
federal and county runs short while testing.

Checks, run locally and in CI (`.github/workflows/ci.yml`) on every pull request:

```
npm run lint            # html-validate, eslint, pyflakes
npm run check:build     # committed pages match a fresh build
npm run test:pipeline   # parsers and end-to-end runs against saved responses in tests/pipeline/fixtures/
npm run test:a11y       # Playwright + axe-core, WCAG 2.2 A/AA/AAA, at 1440, 768, 390 and 320 px
npm run check           # all of the above
```

`tests/a11y-baseline.json` lists the accessibility failures still tolerated per page. Every page of
the main site and the Legislation section is at zero. The volunteer site is not yet in scope.

## Known gaps

- `volunteer/_headers` is absent; the volunteer site has no Content-Security-Policy yet, and its
  text contrast is below AAA.
- San Francisco's Legistar API refuses meeting queries and Los Angeles County publishes only some
  meetings there with no per-supervisor votes, so both are link-only. Solano publishes agenda actions
  without roll calls.
- The Senate sometimes blocks automated requests from cloud providers. If it blocks the nightly job,
  the Senate source is marked stale on the Sources page and the previous records stay up.

## Roster freshness

The roster was last fully checked 2 July 2026, with corrections through 22 September 2026. Four
districts remain unverified because their board systems block crawlers: Feather River, Solano,
Monterey Peninsula, Compton.
