"""
Geography: the state list and, for California, every county with the
congressional, State Senate and Assembly districts that intersect it.

Sources (official):
  Census county codes        https://www2.census.gov/geo/docs/reference/codes2020/cou/st06_ca_cou2020.txt
  Census relationship files  https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/
                             tab20_cd11920_county20_st06.txt   (119th Congress districts, the 2021 map, in force through 2026)
                             tab20_sldu202420_county20_st06.txt (State Senate, 2024 vintage)
                             tab20_sldl202420_county20_st06.txt (Assembly, 2024 vintage)
  AB 604 block equivalency   https://selc.senate.ca.gov/media/604  (Prop 50 congressional map, in force January 2027 to 2032)

Output: data/legislation/geo/states.json and data/legislation/geo/us-ca/counties.json
"""
import csv
import io
import re

from . import writer
from .common import Http, Manifest, http_date_to_iso, now_iso, slugify

COUNTY_CODES = 'https://www2.census.gov/geo/docs/reference/codes2020/cou/st06_ca_cou2020.txt'
REL_BASE = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/'
REL_CD = REL_BASE + 'tab20_cd11920_county20_st06.txt'
REL_SLDU = REL_BASE + 'tab20_sldu202420_county20_st06.txt'
REL_SLDL = REL_BASE + 'tab20_sldl202420_county20_st06.txt'
AB604 = 'https://selc.senate.ca.gov/media/604'
AB604_EFFECTIVE = '2027-01-03'

STATES = [
    ('AL', 'Alabama', '01'), ('AK', 'Alaska', '02'), ('AZ', 'Arizona', '04'), ('AR', 'Arkansas', '05'), ('CA', 'California', '06'),
    ('CO', 'Colorado', '08'), ('CT', 'Connecticut', '09'), ('DE', 'Delaware', '10'), ('FL', 'Florida', '12'), ('GA', 'Georgia', '13'),
    ('HI', 'Hawaii', '15'), ('ID', 'Idaho', '16'), ('IL', 'Illinois', '17'), ('IN', 'Indiana', '18'), ('IA', 'Iowa', '19'),
    ('KS', 'Kansas', '20'), ('KY', 'Kentucky', '21'), ('LA', 'Louisiana', '22'), ('ME', 'Maine', '23'), ('MD', 'Maryland', '24'),
    ('MA', 'Massachusetts', '25'), ('MI', 'Michigan', '26'), ('MN', 'Minnesota', '27'), ('MS', 'Mississippi', '28'), ('MO', 'Missouri', '29'),
    ('MT', 'Montana', '30'), ('NE', 'Nebraska', '31'), ('NV', 'Nevada', '32'), ('NH', 'New Hampshire', '33'), ('NJ', 'New Jersey', '34'),
    ('NM', 'New Mexico', '35'), ('NY', 'New York', '36'), ('NC', 'North Carolina', '37'), ('ND', 'North Dakota', '38'), ('OH', 'Ohio', '39'),
    ('OK', 'Oklahoma', '40'), ('OR', 'Oregon', '41'), ('PA', 'Pennsylvania', '42'), ('RI', 'Rhode Island', '44'), ('SC', 'South Carolina', '45'),
    ('SD', 'South Dakota', '46'), ('TN', 'Tennessee', '47'), ('TX', 'Texas', '48'), ('UT', 'Utah', '49'), ('VT', 'Vermont', '50'),
    ('VA', 'Virginia', '51'), ('WA', 'Washington', '53'), ('WV', 'West Virginia', '54'), ('WI', 'Wisconsin', '55'), ('WY', 'Wyoming', '56'),
    ('DC', 'District of Columbia', '11'), ('PR', 'Puerto Rico', '72'), ('GU', 'Guam', '66'), ('VI', 'U.S. Virgin Islands', '78'),
    ('AS', 'American Samoa', '60'), ('MP', 'Northern Mariana Islands', '69'),
]
DELEGATE_ONLY = {'DC', 'PR', 'GU', 'VI', 'AS', 'MP'}


def states_list():
    out = []
    for code, name, fips in STATES:
        out.append({'code': code, 'name': name, 'fips': fips, 'slug': slugify(name),
                    'coverage': 'full' if code == 'CA' else 'federal',
                    'delegate_only': code in DELEGATE_ONLY,
                    'jurisdiction': 'us-%s' % code.lower()})
    return out


def _pipe_rows(text):
    text = text.lstrip('﻿')
    return list(csv.DictReader(io.StringIO(text), delimiter='|'))


def parse_counties(text):
    out = {}
    for r in _pipe_rows(text):
        fips = r['STATEFP'] + r['COUNTYFP']
        out[fips] = {'fips': fips, 'name': r['COUNTYNAME'], 'slug': slugify(r['COUNTYNAME'].replace(' County', ''))}
    return out


def parse_relationship(text, geoid_col, county_col='GEOID_COUNTY_20', area_col='AREALAND_PART'):
    """county fips -> sorted list of district numbers, ignoring water-only slivers."""
    out = {}
    for r in _pipe_rows(text):
        try:
            land = int(r.get(area_col) or 0)
        except ValueError:
            land = 0
        if land <= 0:
            continue
        geoid = r[geoid_col]
        num = int(geoid[2:])
        out.setdefault(r[county_col], set()).add(num)
    return {k: sorted(v) for k, v in out.items()}


def parse_ab604(text):
    """block GEOID -> district csv; county fips is characters 0-5 of the block GEOID."""
    out = {}
    reader = csv.reader(io.StringIO(text.lstrip('﻿')))
    for row in reader:
        if len(row) < 2 or not row[0].strip().isdigit():
            continue
        block, cd = row[0].strip(), row[1].strip()
        if not cd.isdigit():
            continue
        out.setdefault(block[:5], set()).add(int(cd))
    return {k: sorted(v) for k, v in out.items()}


def main(argv=None):
    http = Http()
    manifest = Manifest()
    writer.write_json('geo/states.json', {'states': states_list(), 'checked_at': now_iso()})

    sid = 'census-geo'
    manifest.describe(sid, 'U.S. Census Bureau county codes and district relationship files', 'https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.html', 'geo')
    try:
        counties = parse_counties(http.get_text(COUNTY_CODES, ttl=30 * 24 * 3600)[0])
        cd = parse_relationship(http.get_text(REL_CD, ttl=30 * 24 * 3600)[0], 'GEOID_CD119_20')
        sldu = parse_relationship(http.get_text(REL_SLDU, ttl=30 * 24 * 3600)[0], 'GEOID_SLDU2024_20')
        sldl = parse_relationship(http.get_text(REL_SLDL, ttl=30 * 24 * 3600)[0], 'GEOID_SLDL2024_20')
        manifest.ok(sid)
    except Exception as e:
        manifest.error(sid, e)
        raise

    sid2 = 'ab604-map'
    manifest.describe(sid2, 'AB 604 congressional districts (Proposition 50), block equivalency file', 'https://selc.senate.ca.gov/', 'geo')
    cd2027 = {}
    try:
        text, meta = http.get_text(AB604, ttl=30 * 24 * 3600)
        cd2027 = parse_ab604(text)
        if len(cd2027) < 50:
            raise RuntimeError('only %d counties in the AB 604 file' % len(cd2027))
        manifest.ok(sid2, source_updated_at=http_date_to_iso(meta.get('last_modified')))
    except Exception as e:
        manifest.error(sid2, e)
        existing = writer.read_json('geo/us-ca/counties.json') or {}
        for c in existing.get('counties', []):
            if c.get('us_house', {}).get('from_2027'):
                cd2027[c['fips']] = c['us_house']['from_2027']
        print('   AB 604 file unavailable (%s); keeping previous 2027 districts for %d counties' % (e, len(cd2027)))

    rows = []
    for fips, c in sorted(counties.items()):
        rows.append({
            'fips': fips, 'name': c['name'], 'slug': c['slug'], 'jurisdiction': 'us-ca-%s' % fips,
            'us_house': {'current': cd.get(fips, []), 'from_2027': cd2027.get(fips, []), 'effective_2027': AB604_EFFECTIVE},
            'ca_senate': sldu.get(fips, []), 'ca_assembly': sldl.get(fips, []),
        })
    writer.write_json('geo/us-ca/counties.json', {'counties': rows, 'checked_at': now_iso(),
                                                  'notes': 'us_house.current is the 2021 Citizens Redistricting Commission map (119th Congress, elections through 2026). us_house.from_2027 is the AB 604 / Proposition 50 map, effective January 2027 through 2032. State Senate and Assembly districts are the 2021 commission map (Census 2024 vintage).'})
    manifest.count('ca_counties', len(rows))
    manifest.save()
    print('   %d counties; CD current for %d, CD 2027 for %d, SD for %d, AD for %d' % (
        len(rows), sum(1 for r in rows if r['us_house']['current']), sum(1 for r in rows if r['us_house']['from_2027']),
        sum(1 for r in rows if r['ca_senate']), sum(1 for r in rows if r['ca_assembly'])))


if __name__ == '__main__':
    main()
