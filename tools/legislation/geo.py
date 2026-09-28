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

Every other state, from the national versions of the same Census files:
  https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt
  tab20_cd11920_county20_natl.txt, tab20_sldu202420_county20_natl.txt, tab20_sldl202420_county20_natl.txt
Board names and websites for those counties come from boards.py (Wikidata, checked nightly).

Output: data/legislation/geo/states.json, geo/us-ca/counties.json, and geo/us-{st}/counties.json
for every other state, DC and Puerto Rico.
"""
import csv
import io
from . import boards, districts, writer
from .common import Http, Manifest, http_date_to_iso, slugify, today

COUNTY_CODES = 'https://www2.census.gov/geo/docs/reference/codes2020/cou/st06_ca_cou2020.txt'
REL_BASE = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/'
REL_CD = REL_BASE + 'tab20_cd11920_county20_st06.txt'
REL_SLDU = REL_BASE + 'tab20_sldu202420_county20_st06.txt'
REL_SLDL = REL_BASE + 'tab20_sldl202420_county20_st06.txt'
AB604 = 'https://selc.senate.ca.gov/media/604'
AB604_EFFECTIVE = '2027-01-03'
NATIONAL_COUNTIES = 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt'
REL_CD_NATL = REL_BASE + 'tab20_cd11920_county20_natl.txt'
REL_SLDU_NATL = REL_BASE + 'tab20_sldu202420_county20_natl.txt'
REL_SLDL_NATL = REL_BASE + 'tab20_sldl202420_county20_natl.txt'
MONTH = 30 * 24 * 3600
SUFFIXES = (' County', ' Parish', ' Census Area', ' Municipio', ' Borough')

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


def states_list(county_counts=None, legislatures=True):
    """Every state and territory. coverage: 'full' (California: legislature, votes, county boards),
    'members' (every other state with a legislature: members of Congress, state legislators, county
    pages), 'federal' (territories with a delegate only)."""
    out = []
    for code, name, fips in STATES:
        row = {'code': code, 'name': name, 'fips': fips, 'slug': slugify(name),
               'coverage': 'full' if code == 'CA' else ('members' if (legislatures and code in districts.STATES) else 'federal'),
               'delegate_only': code in DELEGATE_ONLY,
               'jurisdiction': 'us-%s' % code.lower()}
        if code in districts.STATES:
            _, _, upper, lower = districts.STATES[code]
            chambers = [{'id': 'legislature' if code in ('NE', 'DC') else 'upper', 'name': districts.chamber_label(code, 'upper'), 'seats': upper}]
            if lower:
                chambers.append({'id': 'lower', 'name': districts.chamber_label(code, 'lower'), 'seats': lower})
            row['legislature'] = {'name': districts.legislature_name(code), 'chambers': chambers}
            row['county_word'] = districts.COUNTY_WORD.get(code, 'county')
            if county_counts is not None:
                row['counties'] = county_counts.get(code, 0)
        out.append(row)
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


def parse_national_counties(text):
    """state code -> [(fips, name)] for the states, DC and Puerto Rico."""
    out = {}
    for r in _pipe_rows(text):
        st = r.get('STATE')
        if st in districts.STATES:
            out.setdefault(st, []).append((r['STATEFP'] + r['COUNTYFP'], r['COUNTYNAME']))
    return out


def parse_rel_named(text, geoid_col, name_col, area_col='AREALAND_PART'):
    """county fips -> {district code: district name}, without water-only slivers or 'not defined' areas."""
    out = {}
    for r in _pipe_rows(text):
        geoid = r.get(geoid_col) or ''
        code = geoid[2:]
        if len(geoid) < 3 or set(code) <= {'Z'}:
            continue
        try:
            land = int(r.get(area_col) or 0)
        except ValueError:
            land = 0
        if land <= 0:
            continue
        out.setdefault(r['GEOID_COUNTY_20'], {})[code] = (r.get(name_col) or code).strip()
    return out


def county_slug(name, taken):
    base = name
    if not name.endswith('City and Borough'):
        for suf in SUFFIXES:
            if name.endswith(suf):
                base = name[:-len(suf)]
                break
    s = slugify(base)
    if not s or s in taken:
        s = slugify(name)
    taken.add(s)
    return s


def district_table(rel, fips_list):
    """Canonical key -> {label, aliases} for every district touching these counties, and the
    per-county key lists. The canonical key is districts.key() of the readable label."""
    table, per_county = {}, {}
    for fips in fips_list:
        keys = []
        for code, name in sorted((rel.get(fips) or {}).items()):
            lab = districts.label(code, name)
            k = districts.key(lab)
            entry = table.setdefault(k, {'label': lab, 'aliases': set()})
            names = [a for a in (districts.key(code), districts.key(name), k) if a]
            entry['aliases'].update(names + [a.replace(' ', '') for a in names])
            keys.append(k)
        per_county[fips] = sorted(set(keys), key=_natural)
    return table, per_county


def _natural(k):
    import re
    return [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', k)]


def cd_numbers(rel, fips):
    """Congressional districts overlapping a county. The Census writes 00 for an at-large seat and
    98 for a delegate (DC, Puerto Rico); us/members.json gives both district 0."""
    out = []
    for code in (rel.get(fips) or {}):
        if code.isdigit():
            n = int(code)
            out.append(0 if n == 98 else n)
    return sorted(set(out))


def build_national(http, manifest, cd, sldu, sldl, counties_by_state, sites):
    """Write geo/us-{st}/counties.json for every state but California, and geo/counties.json (every
    county in one small index, for search and the states page). Returns county counts."""
    counts, index = {}, []
    for st, rows_in in sorted(counties_by_state.items()):
        counts[st] = len(rows_in)
        if st == 'CA':
            taken = set()
            index.extend([fips, name, st, county_slug(name, taken)] for fips, name in sorted(rows_in))
            continue
        fips_list = [f for f, _ in rows_in]
        up, up_c = district_table(sldu, fips_list)
        lo, lo_c = district_table(sldl, fips_list)
        prev = {c['fips']: c for c in ((writer.read_json('geo/us-%s/counties.json' % st.lower()) or {}).get('counties') or [])}
        taken, rows = set(), []
        for fips, name in sorted(rows_in):
            bname, none_reason = boards.board_name(st, fips, name)
            old = (prev.get(fips) or {}).get('board') or {}
            old_source = old.get('source_url') or old.get('url')
            url = (sites or {}).get(fips) if sites is not None else old_source
            board = {'fips': fips, 'name': bname}
            if none_reason:
                board = {'fips': fips, 'name': None, 'none': none_reason}
            elif url:
                board.update({'url': url, 'source_url': url, 'url_source': 'Wikidata'})
                if old_source == url:
                    for k in ('url', 'checked_at', 'status', 'code', 'last_ok_at'):
                        if old.get(k):
                            board[k] = old[k]
            rows.append({'fips': fips, 'name': name, 'slug': county_slug(name, taken), 'jurisdiction': 'us-%s-%s' % (st.lower(), fips),
                         'cd': cd_numbers(cd, fips), 'sldu': up_c.get(fips, []), 'sldl': lo_c.get(fips, []), 'board': board})
        checked = boards.check_links([r['board'] for r in rows], today())
        for r in rows:
            r['board'].pop('fips', None)
        doc = {'state': st, 'schema_version': 1, 'county_word': districts.COUNTY_WORD.get(st, 'county'),
               'districts': {'upper': {k: v['label'] for k, v in up.items()},
                             'lower': {k: v['label'] for k, v in lo.items()},
                             'aliases': {'upper': {a: k for k, v in up.items() for a in v['aliases']},
                                         'lower': {a: k for k, v in lo.items() for a in v['aliases']}}},
               'counties': rows,
               'notes': 'Districts overlapping each county come from the Census Bureau 2024 relationship files (land area only). '
                        'cd is the 119th Congress map; sldu and sldl are canonical district keys, labelled in districts.'}
        writer.write_json('geo/us-%s/counties.json' % st.lower(), doc)
        index.extend([r['fips'], r['name'], st, r['slug']] for r in rows)
        if checked:
            print('   %s: %d board links checked' % (st, checked))
    index.sort(key=lambda r: (r[1].lower(), r[2]))
    writer.write_json('geo/counties.json', {'schema_version': 1, 'columns': ['fips', 'name', 'state', 'slug'], 'rows': index})
    return counts


def main(argv=None):
    http = Http()
    manifest = Manifest()

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
        counties = None
        print('   California Census files unavailable (%s); keeping geo/us-ca/counties.json' % e)
    national(http, manifest, sid)
    if counties is not None:
        california(http, manifest, counties, cd, sldu, sldl)
    manifest.save()


def national(http, manifest, sid):
    """Every other state, DC and Puerto Rico, then geo/states.json. A failure keeps last night's files."""
    counts = None
    try:
        by_state = parse_national_counties(http.get_text(NATIONAL_COUNTIES, ttl=MONTH)[0])
        cd_n = parse_rel_named(http.get_text(REL_CD_NATL, ttl=MONTH)[0], 'GEOID_CD119_20', 'NAMELSAD_CD119_20')
        up_n = parse_rel_named(http.get_text(REL_SLDU_NATL, ttl=MONTH)[0], 'GEOID_SLDU2024_20', 'NAMELSAD_SLDU2024_20')
        lo_n = parse_rel_named(http.get_text(REL_SLDL_NATL, ttl=MONTH)[0], 'GEOID_SLDL2024_20', 'NAMELSAD_SLDL2024_20')
        sites = boards.wikidata_sites(http, manifest)
        counts = build_national(http, manifest, cd_n, up_n, lo_n, by_state, sites)
        total = sum(counts.values())
        manifest.count('us_counties', total)
        manifest.source(sid)['note'] = '%d counties and county equivalents in %d states, DC and Puerto Rico' % (total, len(counts) - 2)
        print('   national: %d counties in %d jurisdictions' % (total, len(counts)))
    except Exception as e:
        manifest.partial(sid, 'national files unavailable: %s' % e)
        print('   national geography unavailable (%s); keeping the previous state files' % e)
        prev = writer.read_json('geo/states.json') or {}
        counts = {s['code']: s['counties'] for s in prev.get('states', []) if s.get('counties')} or None
    writer.write_json('geo/states.json', {'states': states_list(counts)})


def california(http, manifest, counties, cd, sldu, sldl):
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
    writer.write_json('geo/us-ca/counties.json', {'counties': rows,
                                                  'notes': 'us_house.current is the 2021 Citizens Redistricting Commission map (119th Congress, elections through 2026). us_house.from_2027 is the AB 604 / Proposition 50 map, effective January 2027 through 2032. State Senate and Assembly districts are the 2021 commission map (Census 2024 vintage).'})
    manifest.count('ca_counties', len(rows))
    print('   %d counties; CD current for %d, CD 2027 for %d, SD for %d, AD for %d' % (
        len(rows), sum(1 for r in rows if r['us_house']['current']), sum(1 for r in rows if r['us_house']['from_2027']),
        sum(1 for r in rows if r['ca_senate']), sum(1 for r in rows if r['ca_assembly'])))


if __name__ == '__main__':
    main()
