"""
County boards outside California: what the governing body is called and where its website is.

Website: Wikidata's "official website" (P856) for every item carrying a five-digit FIPS code
(P882), refreshed monthly. Wikidata is edited by volunteers, so each link is checked: one
seventh of the counties each night (a full pass every week), HEAD then GET, eight at a time,
five seconds each, https first when Wikidata gives http. The result (ok, blocked, dead,
unreachable) and its time are published, so the site can say when a link was last seen working.

Names: where a state uses one name for every county's board (Texas: Commissioners Court) the
page uses it; elsewhere it says "County government". States without county government say so.
"""
import os
import re
from concurrent.futures import ThreadPoolExecutor

from . import districts
from .common import USER_AGENT, now_iso

WIKIDATA = 'https://query.wikidata.org/sparql'
QUERY = ('SELECT ?fips ?site WHERE { ?item wdt:P882 ?fips . FILTER(STRLEN(?fips)=5) '
         'FILTER NOT EXISTS { ?item wdt:P576 ?end } ?item wdt:P856 ?site . }')
CHECK_TIMEOUT = 5
CHECK_WORKERS = 8
CHECK_LIMIT = 700

# One name for every county board in the state (verified conventions; exceptions are rare and noted in the UI as "usually").
BOARD_NAME = dict(districts.BOARD_NAME, **{
    'FL': 'Board of County Commissioners', 'NC': 'Board of Commissioners', 'AL': 'County Commission', 'TN': 'County Commission',
    'KY': 'Fiscal Court', 'AR': 'Quorum Court', 'SC': 'County Council', 'WV': 'County Commission', 'DE': 'County Council',
    'HI': 'County Council', 'MI': 'Board of Commissioners', 'MN': 'Board of Commissioners', 'ND': 'Board of County Commissioners',
    'SD': 'Board of County Commissioners', 'WY': 'Board of County Commissioners', 'OK': 'Board of County Commissioners',
    'NM': 'Board of County Commissioners', 'ID': 'Board of County Commissioners', 'KS': 'Board of County Commissioners',
    'IN': 'Board of Commissioners', 'WI': 'County Board', 'ME': 'County Commissioners',
})
NO_GOVERNMENT = dict(districts.NO_COUNTY_GOVERNMENT, **{
    'VT': 'Vermont counties have no general-purpose government; towns govern locally.',
})


def board_name(st, fips, name):
    """(name, reason_if_none)."""
    if st in NO_GOVERNMENT:
        return None, NO_GOVERNMENT[st]
    if st == 'AK':
        if name.endswith('Census Area'):
            return None, 'Part of the Unorganized Borough, which has no borough government; the state provides services.'
        return 'Assembly', None
    if fips == '32510':
        return 'Board of Supervisors', None           # Carson City
    if name.endswith(' city'):
        return 'City Council', None                   # independent cities (Virginia, Baltimore, St. Louis)
    if st == 'LA':
        return 'Parish government', None
    return BOARD_NAME.get(st, 'County government'), None


def pick_url(urls):
    """Prefer https, then government domains, then the shortest."""
    def score(u):
        return (not u.startswith('https://'), not re.search(r'\.(gov|us)(/|$)', u), len(u))
    good = [u for u in urls if re.match(r'^https?://[^\s/]+\.[^\s/]+', u)]
    return sorted(good, key=score)[0] if good else None


def wikidata_sites(http, manifest):
    """fips -> url, or None when Wikidata cannot be reached (callers keep last night's links)."""
    sid = 'wikidata-county-sites'
    manifest.describe(sid, 'Wikidata: official websites of U.S. counties (P856)', 'https://www.wikidata.org/wiki/Property:P856',
                      'county', official=False, license='CC0')
    try:
        data, meta = http.get_json(WIKIDATA, ttl=30 * 24 * 3600, params={'query': QUERY, 'format': 'json'},
                                   headers={'Accept': 'application/sparql-results+json'})
        sites = {}
        for b in data['results']['bindings']:
            if 'site' in b and 'fips' in b:
                sites.setdefault(b['fips']['value'], set()).add(b['site']['value'])
        out = {k: pick_url(v) for k, v in sites.items()}
        out = {k: v for k, v in out.items() if v}
        manifest.ok(sid, note='%d counties with a website' % len(out))
        return out
    except Exception as e:
        manifest.error(sid, e)
        print('   wikidata unavailable: %s' % e)
        return None


def _check(url):
    import requests
    headers = {'User-Agent': USER_AGENT}
    try:
        r = requests.head(url, headers=headers, timeout=CHECK_TIMEOUT, allow_redirects=True)
        if r.status_code in (400, 403, 405, 501):
            r = requests.get(url, headers=headers, timeout=CHECK_TIMEOUT, allow_redirects=True, stream=True)
            r.close()
        code = r.status_code
    except Exception:
        return 'unreachable', None
    if code < 400:
        return 'ok', code
    if code in (401, 403, 429):
        return 'blocked', code
    if code in (404, 410):
        return 'dead', code
    return 'unreachable', code


def due(fips, today_date):
    return int(fips) % 7 == today_date.toordinal() % 7


def check_links(boards, today_date, checker=None, limit=CHECK_LIMIT):
    """boards: list of board dicts with 'fips' and 'url' (and 'source_url', the address as Wikidata
    gives it). Checks the ones due tonight, and any never checked, up to the limit, in place.
    An http address is tried as https first and published as https when that answers.
    Returns the number checked. LEGIS_NO_LINKCHECK=1 skips."""
    if os.environ.get('LEGIS_NO_LINKCHECK'):
        return 0
    checker = checker or _check

    def probe(b):
        url = b.get('source_url') or b['url']
        if url.startswith('http://'):
            secure = 'https://' + url[len('http://'):]
            status, code = checker(secure)
            if status == 'ok':
                return secure, status, code
        status, code = checker(url)
        return url, status, code

    todo = [b for b in boards if b.get('url') and (not b.get('checked_at') or due(b['fips'], today_date))][:limit]
    if not todo:
        return 0
    with ThreadPoolExecutor(CHECK_WORKERS) as pool:
        results = list(pool.map(probe, todo))
    stamp = now_iso()
    for b, (url, status, code) in zip(todo, results):
        b['url'] = url
        b['status'] = status
        b['checked_at'] = stamp
        if code:
            b['code'] = code
        else:
            b.pop('code', None)
        if status == 'ok':
            b['last_ok_at'] = stamp
    return len(todo)
