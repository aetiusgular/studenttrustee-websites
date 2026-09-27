# studenttrustee.net

Two static sites, one repo. No build step: what is in each folder is what gets
served, so anything you can open in a browser locally is exactly what ships.

```
studenttrustee/ -> studenttrustee.net
volunteer/      -> volunteer.studenttrustee.net
```

## Deploying

Each folder is its own Netlify site. In Netlify, for each one:

| Setting           | studenttrustee.net | volunteer.studenttrustee.net |
|-------------------|--------------------|------------------------------|
| Base directory    | `studenttrustee`   | `volunteer`                  |
| Build command     | *(leave empty)*    | *(leave empty)*              |
| Publish directory | `studenttrustee`   | `volunteer`                  |

Once both are pointed at this repo, pushing to `main` deploys. No more
drag-and-drop, and no more losing files to a bad upload.

## What is here

**studenttrustee/** — landing page, the 72-district map, legislative calendars, about.
Every HTML file in it is rendered by `tools/build.py` from the Jinja2 templates
in `tools/templates/` and the data in `studenttrustee/data/` (`roster.json` is
the trustee roster, `site.json` the verification dates). Edit a template or the
data, run `python3 tools/build.py`, commit the output. CI fails if the committed
pages are stale. Shared styles live in `assets/site.css` (tokens meet WCAG AAA
contrast), page styles in `assets/<page>.css`, scripts in `assets/<page>.js`.
Leaflet is vendored under `vendor/leaflet-1.9.4/` so the site has no runtime
dependency on a CDN. `map.html` pulls district boundaries from the Foundation
for California Community Colleges GIS service at runtime. The basemap is Esri
Light Gray Canvas; it was CARTO until CARTO started requiring an API key and
stamping unkeyed tiles with a watermark.

**volunteer/** — the Bay Area volunteer directory. `data.js` holds all 262
organizations; `index.html` is the whole interface.

**brand/** — shared identity. The poppy mark, the wordmark, the favicon set.
`poppy-p6.svg` is true vector; the PNGs and the `.ico` are rasters of the same
artwork. The `-p6` suffix is a cache-busting version: Safari keys its favicon
cache on the URL path, so changing an icon means changing its filename, not
just adding a query string.

## Known gaps

These are missing and known, not forgotten:

- **`volunteer/_headers` is absent.** The main site's `_headers` was rewritten
  (with a Content-Security-Policy); the volunteer site still has none.

## Roster freshness

The roster was last fully checked 2 July 2026, with corrections through
22 September 2026. Four districts remain unverified because their board
systems block crawlers: Feather River, Solano, Monterey Peninsula, Compton.

## Developing

Checks run locally and in CI (`.github/workflows/ci.yml`) on every pull request.

```
npm install                       # lint and test tooling (Node 20+)
python3 -m pip install -r requirements.txt   # template build and data pipeline
npm run lint                      # html-validate + eslint on every page
npm run test:a11y                 # Playwright + axe-core, WCAG 2.2 A/AA/AAA rules, at 1440, 768, 390 and 320 px
npm run check                     # everything CI runs
```

`tests/a11y-baseline.json` lists the accessibility failures still tolerated per page. The goal is to empty it, not to grow it.
