#!/usr/bin/env python3
"""
Snapshot the 72 community college district boundaries into a static file.

The map used to query ArcGIS Online at page load. That query costs the visitor
2.5 to 3.5 seconds of server time on every fresh visit and is cacheable for
only 30 seconds, for polygons that change about once a year. This script does
the query once, simplifies the geometry, checks every district name against
the roster, and writes studenttrustee/data/districts.geojson, which Netlify
then serves from its CDN in a few tens of milliseconds.

    python3 -m tools.legislation.boundaries               # fetch, simplify, write
    python3 -m tools.legislation.boundaries --source raw.geojson   # from a saved download
    python3 -m tools.legislation.boundaries --check       # exit 1 if the file is missing or invalid

The nightly run first reads the layer's last-edit date (a small metadata
request) and stops there when it matches the committed file, so the 11 MB
geometry download only happens after the source has actually been edited.
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SITE = os.path.join(ROOT, 'studenttrustee')
OUT = os.path.join(SITE, 'data', 'districts.geojson')
ROSTER = os.path.join(SITE, 'data', 'roster.json')

SOURCE_URL = ('https://services6.arcgis.com/XNnWmtFBLgSx99Bz/arcgis/rest/services/'
              'CCC_ArcGIS__Map_Bundle/FeatureServer/4/query?where=1%3D1&outFields=DistrictNa,ShortName'
              '&outSR=4326&geometryPrecision=6&returnGeometry=true&f=geojson')
SOURCE_NAME = 'Foundation for California Community Colleges GIS (ArcGIS Online, CCC_ArcGIS__Map_Bundle layer 4)'
TOLERANCE = 0.002       # degrees, about 200 m; Leaflet draws these at zoom 5 to 13 with smoothFactor 2
PRECISION = 5           # decimals, about 1 m
MIN_RING_AREA = 2e-6    # square degrees; drops slivers and rocks below ~200 m across

STOP = {"community", "college", "colleges", "district", "districts", "ccd", "joint",
        "county", "area", "the", "of", "junior", "unified", "and"}


def norm(s):
    """Same normalisation as assets/map.js so both sides match the same way."""
    s = unicodedata.normalize('NFD', s or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower()
    words = [w for w in re.sub(r'[^a-z0-9]+', ' ', s).split() if w]
    words = ['mt' if w == 'mount' else ('st' if w == 'saint' else w) for w in words]
    return ' '.join(w for w in words if w not in STOP)


def match_district(raw, index):
    k = norm(raw)
    if k in index:
        return index[k]
    kc = k.replace(' ', '')
    for key, d in index.items():
        if key.replace(' ', '') == kc:
            return d
    kt = set(k.split())
    best, best_score = None, 0
    for key, d in index.items():
        dt = set(key.split())
        inter = len(kt & dt)
        score = inter / len(kt | dt) if (kt | dt) else 0
        if score > best_score:
            best, best_score = d, score
    return best if best_score >= 0.55 else None


LAYER_URL = SOURCE_URL.split('/query?')[0] + '?f=json'


def layer_last_modified():
    """The layer's last edit as an HTTP date, from its small metadata document (about 11 KB),
    so the nightly run can skip the 11 MB geometry download when nothing has changed."""
    import requests
    from email.utils import formatdate
    r = requests.get(LAYER_URL, timeout=60, headers={'User-Agent': 'studenttrustee.net boundaries snapshot (+https://studenttrustee.net)'})
    r.raise_for_status()
    ms = (r.json().get('editingInfo') or {}).get('lastEditDate')
    return formatdate(ms / 1000, usegmt=True) if ms else None


def fetch(url):
    import requests
    r = requests.get(url, timeout=120, headers={'User-Agent': 'studenttrustee.net boundaries snapshot (+https://studenttrustee.net)'})
    r.raise_for_status()
    gj = r.json()
    if gj.get('error'):
        raise RuntimeError('ArcGIS error: %s' % gj['error'])
    return gj, r.headers.get('Last-Modified')


def simplify(geometry):
    from shapely.geometry import shape, mapping, MultiPolygon, Polygon
    geom = shape(geometry)
    geom = geom.simplify(TOLERANCE, preserve_topology=True)
    polys = list(geom.geoms) if geom.geom_type == 'MultiPolygon' else [geom]
    kept = []
    for p in polys:
        if p.is_empty or p.area < MIN_RING_AREA:
            continue
        holes = [h for h in p.interiors if Polygon(h).area >= MIN_RING_AREA]
        kept.append(Polygon(p.exterior, holes))
    if not kept:
        kept = [max(polys, key=lambda p: p.area)]
    out = kept[0] if len(kept) == 1 else MultiPolygon(kept)
    out = mapping(out)

    def rnd(coords):
        if isinstance(coords[0], (int, float)):
            return [round(coords[0], PRECISION), round(coords[1], PRECISION)]
        return [rnd(c) for c in coords]
    out['coordinates'] = rnd(out['coordinates'])
    return out


def build(gj, roster, last_modified):
    index = {norm(d['name']): d for d in roster['districts']}
    features, used, unmatched = [], set(), []
    for f in gj['features']:
        raw = f['properties'].get('DistrictNa') or f['properties'].get('ShortName') or ''
        d = match_district(raw, index)
        if not d:
            unmatched.append(raw)
            continue
        if d['name'] in used:
            continue
        used.add(d['name'])
        features.append({'type': 'Feature',
                         'properties': {'district': d['name'], 'source_name': raw},
                         'geometry': simplify(f['geometry'])})
    features.sort(key=lambda f: f['properties']['district'])
    missing = sorted(set(d['name'] for d in roster['districts']) - used)
    return {
        'type': 'FeatureCollection',
        'properties': {
            'source': SOURCE_NAME, 'source_url': SOURCE_URL,
            'source_last_modified': last_modified,
            'simplify_tolerance_deg': TOLERANCE, 'coordinate_precision': PRECISION,
            'districts': len(features), 'unmatched_source_names': unmatched, 'missing_districts': missing,
        },
        'features': features,
    }


def load_existing():
    try:
        with open(OUT, encoding='utf-8') as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return None


def same_geometry(a, b):
    if not a or not b:
        return False
    strip = lambda fc: json.dumps([[f['properties']['district'], f['geometry']] for f in fc['features']], sort_keys=True)
    return strip(a) == strip(b) and a['properties'].get('source_last_modified') == b['properties'].get('source_last_modified')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--source', help='read the ArcGIS GeoJSON from a file instead of fetching it')
    ap.add_argument('--last-modified', help='Last-Modified value to record when --source is used')
    ap.add_argument('--check', action='store_true', help='validate the committed file and exit')
    ap.add_argument('--force', action='store_true', help='write even if nothing changed')
    args = ap.parse_args(argv)

    with open(ROSTER, encoding='utf-8') as fh:
        roster = json.load(fh)

    if args.check:
        fc = load_existing()
        if not fc:
            sys.exit('%s is missing or not JSON' % OUT)
        names = {f['properties']['district'] for f in fc['features']}
        missing = sorted(set(d['name'] for d in roster['districts']) - names)
        if missing:
            sys.exit('districts without a boundary: %s' % ', '.join(missing))
        print('districts.geojson: %d districts, %d KB, source modified %s' % (
            len(fc['features']), os.path.getsize(OUT) // 1024, fc['properties'].get('source_last_modified')))
        return

    if args.source:
        with open(args.source, encoding='utf-8') as fh:
            gj = json.load(fh)
        last_modified = args.last_modified
    else:
        if not args.force:
            current = (load_existing() or {}).get('properties', {}).get('source_last_modified')
            edited = layer_last_modified()
            if edited and current == edited:
                print('districts.geojson up to date (layer last edited %s)' % edited)
                return
        gj, last_modified = fetch(SOURCE_URL)

    fc = build(gj, roster, last_modified)
    if fc['properties']['missing_districts']:
        sys.exit('refusing to write: no boundary matched for %s' % ', '.join(fc['properties']['missing_districts']))
    existing = load_existing()
    if not args.force and same_geometry(existing, fc):
        print('districts.geojson unchanged (source modified %s)' % last_modified)
        return
    fc['properties']['fetched_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')
    print('wrote %s: %d districts, %d KB, unmatched source names: %s' % (
        OUT, len(fc['features']), os.path.getsize(OUT) // 1024, fc['properties']['unmatched_source_names'] or 'none'))


if __name__ == '__main__':
    main()
