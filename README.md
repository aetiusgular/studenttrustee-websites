# studenttrustee.net

Two static sites, one repo, plus a nightly job that collects legislative records.

```
studenttrustee/ -> studenttrustee.net            (Netlify, deploys from main)
volunteer/      -> volunteer.studenttrustee.net  (Netlify, deploys from main)
data branch     -> the Legislation section's records (GitHub Pages, updated nightly)
```

Everything here is free to run: no API keys, no paid services.

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

The records do not live on `main`. They live on the `data` branch, which GitHub Pages serves and
the nightly workflow replaces every night ([why](#choices-and-caveats)). Someone with admin rights
on the GitHub repository does this once:

1. Push the `data` branch (`git push origin data`).
2. Settings > Pages > Build and deployment: Source **Deploy from a branch**, Branch **data**, folder
   **/ (root)**. Save. The records then appear at `https://nbonasera.github.io/studenttrustee-websites/`.
3. Settings > Actions > General > Workflow permissions: **Read and write permissions**, so the nightly
   job can push the `data` branch.

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
it; `/legislature` redirects to `/legislation/calendars/`.

| Level   | Where it comes from | What is shown |
|---------|---------------------|---------------|
| Federal | Clerk of the House roll-call XML; Senate LIS vote XML and member file; GovInfo Bill Status XML; docs.house.gov Bills This Week; senate.gov hearings and floor schedule; Senate Daily Press Gallery; congress-legislators (CC0) for member identity; Voteview (UCLA) only when senate.gov refuses the job | every roll call of the current Congress with each member's position; every bill that got a roll call, with sponsors, cosponsors, committees, actions and summary; each member's record; what is scheduled |
| State (California) | The Legislature's nightly database export (LegInfo pubinfo, about 1.1 GB) | every bill of the session, every floor and committee vote with positions, each legislator's record, the Daily File and committee hearings |
| County (California) | Granicus Legistar public API for the 17 counties that use it; the official board pages for the other 41 | meetings, agenda actions and each supervisor's vote for the last 90 days where the county publishes them; links and a nightly reachability check everywhere else |

People move from the list of states to a state, then to a county. Search covers states,
California counties, federal and state legislators, and bills; county supervisors and agenda items
are searched on each county's page. The vote list filters by level, chamber, county board, session or month, and result; the
bill list by level, type and status; the schedule by level; each legislator's record by their
position and by question or bill. Every record is marked federal, state or county in words, not
only in colour, links to its official page, and shows when its source last changed it.
`manifest.json` records, for every source, when it was last checked, whether that check worked,
and the counts; the Sources page shows it.

**tools/legislation/**: the pipeline. `refresh.py` runs the targets (`boundaries geo federal
california counties`); each is independent. `validate.py` then checks that every index row points
at a real record and every position names a known member, and applies the shrink guard described
below. The workflow publishes only if validation passes.

**volunteer/**: the Bay Area volunteer directory. `data.js` holds all 262 organizations;
`index.html` is the whole interface.

**brand/**: shared identity. The `-p6` suffix on icon files is a cache-busting version.

## How the records stay current

- `.github/workflows/data-refresh.yml` runs at 06:30 UTC (23:30 Pacific in summer, 22:30 in winter).
  A vote taken today appears after tonight's run, so the site can be up to a day behind the
  chambers' own pages.
- A source that fails keeps its last good copy, and the Sources page marks it. A single request that
  fails is answered from the previous night's cached copy when there is one, and the source is
  marked "partly updated".
- The shrink guard refuses to publish if a count that should only grow during a Congress or a
  session falls sharply: bills, votes or members by more than 20 percent, county votes or meetings
  by half. That catches a feed that answers with an empty page. A new Congress (3 January of odd
  years) or California session (the first Monday of December in even years) starts its counts
  again, and schedule counts are not guarded, because a recess empties them. If a real drop is ever
  blocked, run the workflow by hand (Actions > Nightly data refresh > Run workflow) with **Publish
  even if a record count fell sharply** ticked.
- If the job stops for any reason, every Legislation page says so once the records are more than
  36 hours old.
- GitHub emails a failed run to the person who last changed the workflow's schedule, or who last
  re-enabled it.
- GitHub switches off scheduled workflows in a public repository after 60 days without activity.
  A commit to `main` resets the clock. If it happens, enable the workflow again under Actions >
  Nightly data refresh.

## Choices and caveats

Everything was chosen to be free and to serve the site's purpose, California community college
trustees. Where an option was outside that purpose, the cheaper one won. Each caveat is what the
choice costs.

1. **The records are served by GitHub Pages, not Netlify.** On Netlify's credit-based Free plan
   (accounts created on or after 4 September 2025) every production deploy costs 15 of the plan's
   300 monthly credits, and when the credits run out Netlify pauses every site on the account.
   Thirty nightly deploys would do that. GitHub Pages is free for a public repository.
   *Caveats:* the section depends on a second host; if GitHub Pages is down, the Legislation pages
   show an error while the rest of the site works. The repository must stay public (Pages for a
   private repository needs a paid GitHub plan). The `data` branch keeps no history: each night
   replaces it, and the manifest records when each source last changed.

2. **Senate votes come from senate.gov, with Voteview as the fallback.** senate.gov sometimes
   refuses requests from cloud servers such as GitHub's runners. When it does, votes already
   published stay, and new ones are filled in from Voteview, a UCLA database built from the same
   records. *Caveats:* Voteview is not an official source, can lag by a day, and gives the date of
   a vote but not the time. Those votes say so on their page and link to the Senate's own page;
   the Senate's copy replaces them on the next night senate.gov answers.

3. **Bill details come from GovInfo's bulk Bill Status files, not the Congress.gov API.** Same
   Library of Congress data, and no key to request or keep secret. *Caveats:* GovInfo refreshes the
   files every few hours and Congress.gov posts floor actions the morning after, so a bill's action
   list can trail its newest roll call by a day. Summaries from the Congressional Research Service
   are often missing for recent bills. Only bills that got a roll call are listed, because the
   section is about votes.

4. **Expected Senate votes come from the Senate Daily Press Gallery.** The Senate's own schedule
   file says only when the Senate meets; the Press Gallery (nonpartisan staff) posts when votes are
   expected. *Caveats:* the posts are prose written for reporters. The job reads when the Senate
   next meets and quotes the rest, so unusual wording can be missed, and floor times change during
   the day. The item is labelled advisory and links to the post. The Senate Democrats' schedule
   feed has similar detail but comes from one party's caucus, so it is not used.

5. **California comes from the Legislature's full nightly export.** It is the only official
   machine-readable source with every vote and every member's position. *Caveats:* it is about
   1.1 GB and takes a few minutes to download each night. If the Legislature's export stalls, the
   last good copy stays up and the Sources page says so; third-party services (Open States,
   LegiScan) are built from the same export, so none of them would be fresher. The export records
   the date of each vote, not the time. The small daily incremental files were not used because
   they do not record deletions.

6. **County votes come only from counties that publish through Legistar's public API.** Seventeen
   counties do; most publish each supervisor's vote, and the ones that publish agenda actions
   without roll calls are labelled that way. The other 41 counties link to their official board
   pages, which the job checks every night. Legistar is the only free, structured feed that many
   counties share; the rest publish PDFs or use platforms whose robots.txt forbids automated
   crawling. *Caveats:* most large counties have no votes here, including Los Angeles (its votes
   are in Statement of Proceedings PDFs), San Francisco (its Legistar API stopped updating in
   2020), Sacramento, Orange, Riverside, Alameda and Santa Clara. County records cover the last
   90 days. Tuolumne's CivicClerk system publishes structured votes and is the next county worth
   adding.

7. **Other states have federal records only.** Every state has its congressional delegation and
   their votes. Legislatures and county boards outside California are not collected: national
   coverage would need a keyed third-party service with a small free quota (Open States) or 49
   separate feeds, for readers the site does not serve.

8. **There is no address lookup.** People find their representatives by state, county, district
   or name, and a county that spans several districts lists all of them. A free lookup can be
   added later: Census TIGERweb answers point-in-district queries from the browser.

9. **Maps and times.** California's congressional map changes on 3 January 2027 (Proposition 50,
   AB 604); county pages show the current districts and, where they differ, the ones from 2027.
   Vote times and update times are shown in Pacific time with the zone named (PDT or PST), because
   the site serves California. Scheduled federal items keep the Eastern time the House and Senate
   publish, marked ET. Where a source gives no change time (Voteview), a record shows when the job
   retrieved it instead.

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
`node tools/dev/keyboard.mjs http://127.0.0.1:8100` walks the Legislation section with the
keyboard, and `node tools/dev/routes.mjs http://127.0.0.1:8100 /legislation/ ...` loads routes and
reports console errors and failed requests.

## Known gaps

- `volunteer/_headers` is absent; the volunteer site has no Content-Security-Policy yet, and its
  text contrast is below AAA.
- The county, address and state-legislature limits under [Choices and caveats](#choices-and-caveats).

## Roster freshness

The roster was last fully checked 2 July 2026, with corrections through 22 September 2026. Four
districts remain unverified because their board systems block crawlers: Feather River, Solano,
Monterey Peninsula, Compton.
