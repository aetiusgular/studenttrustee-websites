"""
Every state legislature's members (all states but California, whose members come from the
Legislature's own export in california.py), plus DC's council and Puerto Rico's Legislative
Assembly.

Source: Open States (Plural) current legislators, one CSV per state, public domain, no key:
  https://data.openstates.org/people/current/{st}.csv
Columns used: id (ocd-person), name, current_party, current_district, current_chamber, email,
capitol_voice, links, wikidata. Open States assembles these from each legislature's website; it is
not an official record, and the site says so.

District matching: each legislator's district is normalized with districts.key() and looked up in
the aliases written by geo.py for that state (Census 2024 districts), which ties legislators to the
counties they represent. At-large seats (DC, Puerto Rico) cover every county.

Output per state:
  us-{st}/members.json    members with district_key (null when unmatched) and at_large
  us-{st}/summary.json    chambers with seats, members, vacancies, parties and the chamber's
                          own website; source times
and legislatures.json, one row per legislature (California's from california.py's file) for the
states table: members, seats, vacancies, source and its update time; and search/states.json,
every state's search rows in one file for the search page.

A state whose file loses more than a fifth of its legislators overnight keeps the previous file
(a truncated download must not empty a state's page), unless ALLOW_SHRINK=1.
"""
import csv
import hashlib
import io
import os
import re

from . import districts, writer
from .common import Http, Manifest, http_date_to_iso, now_iso

PEOPLE = 'https://data.openstates.org/people/current/%s.csv'
PARTY = {'democratic': 'D', 'democrat': 'D', 'republican': 'R', 'independent': 'I', 'libertarian': 'L', 'green': 'G',
         'nonpartisan': 'NP', 'progressive': 'P', 'new progressive': 'PNP', 'popular democratic': 'PPD',
         'puerto rican independence': 'PIP', 'citizens victory movement': 'MVC', 'project dignity': 'PD',
         'working families': 'WF', 'forward': 'F'}
AT_LARGE = re.compile(r'^(at[- ]?large|statewide|chairman|chair)$', re.I)
SCHEMA = 1


def party_code(name):
    n = (name or '').strip().lower()
    if not n:
        return ''
    if n in PARTY:
        return PARTY[n]
    return ''.join(w[0] for w in n.split() if w)[:3].upper()


def short_id(st, ocd_id):
    uuid = (ocd_id or '').split('/')[-1]
    token = uuid.replace('-', '')[:8] if uuid else hashlib.sha1((ocd_id or '').encode()).hexdigest()[:8]
    return '%s-%s' % (st.lower(), token)


def clean_url(u):
    u = (u or '').strip()
    return u if re.match(r'^https?://[^\s/]+\.[^\s]+$', u) else None


def official_link(links, st):
    """The legislature's own page for the member when it is among the links, else the first link."""
    urls = [u for u in (clean_url(x) for x in (links or '').split(';')) if u]
    gov = [u for u in urls if re.search(r'\.(gov|us)(/|$)|legis|senate|house|assembly', u, re.I)]
    pick = (gov or urls or [None])[0]
    if pick and pick.startswith('http://'):
        pick = 'https://' + pick[len('http://'):]
    return pick


def match_district(district, chamber, table, county_names):
    """(district_key, county_fips list). Tries the normalized name, the name without spaces
    ('Chittenden Southeast' vs the Census 'Chittenden South East'), a numbered seat without its seat
    letter (Idaho's '1A' and '1B' share district 1), and finally a district named after its county
    (New Hampshire's floterial districts such as 'Belknap 8', which the Census files do not carry)."""
    k = districts.key(district)
    for cand in (k, k.replace(' ', '')):
        if cand in table:
            return table[cand], []
    m = re.fullmatch(r'(\d+)[a-z]', k)
    if chamber == 'lower' and m and m.group(1) in table:
        return table[m.group(1)], []
    m = re.fullmatch(r"([A-Za-z .'-]+?) \d+", district)
    if m and m.group(1).lower() in county_names:
        return None, [county_names[m.group(1).lower()]]
    return None, []


def county_name_index(geo):
    out = {}
    for c in (geo or {}).get('counties') or []:
        base = c['name']
        for suf in (' County', ' Parish', ' Borough', ' Census Area', ' Municipio'):
            if base.endswith(suf):
                base = base[:-len(suf)]
        out[base.lower()] = c['fips']
    return out


def parse_people(text, st, aliases, county_names=None):
    """Rows of the Open States CSV -> member dicts. aliases: {'upper': {alias: key}, 'lower': {...}}."""
    out, unmatched = [], 0
    for r in csv.DictReader(io.StringIO(text.lstrip('﻿'))):
        chamber = (r.get('current_chamber') or '').strip()
        if chamber not in ('upper', 'lower', 'legislature'):
            continue
        district = ' '.join((r.get('current_district') or '').split())
        at_large = bool(AT_LARGE.match(district))
        table = aliases.get('upper' if chamber in ('upper', 'legislature') else 'lower', {})
        key, county_fips = (None, []) if at_large else match_district(district, chamber, table, county_names or {})
        if not key and not at_large and not county_fips:
            unmatched += 1
        party_name = (r.get('current_party') or '').strip()
        out.append({
            'id': short_id(st, r.get('id')), 'ocd_id': r.get('id'), 'name': ' '.join((r.get('name') or '').split()),
            'party': party_code(party_name), 'party_name': party_name, 'chamber': chamber,
            'body': 'us-%s-%s' % (st.lower(), 'upper' if chamber == 'legislature' else chamber),
            'district': district, 'district_key': key, 'at_large': at_large, 'county_fips': county_fips or None,
            'email': (r.get('email') or '').strip() or None, 'phone': (r.get('capitol_voice') or '').strip() or None,
            'url': official_link(r.get('links'), st), 'wikidata': (r.get('wikidata') or '').strip() or None,
            'level': 'state', 'jurisdiction': 'us-%s' % st.lower(),
        })
    out.sort(key=lambda m: (m['chamber'], _natural(m['district']), m['name']))
    return out, unmatched


def district_words(m):
    """'District 14', 'Belknap 8', 'at large': how a page names a legislator's district."""
    if m.get('at_large'):
        return 'at large'
    d = m.get('district') or ''
    return 'District %s' % d if re.fullmatch(r'\d+[A-Za-z]?', d) else d


def _natural(s):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r'(\d+)', s or '')]


def official_site(members):
    """The chamber's own website, as the host most of its members' official pages share (at least
    two in five of them). None when the links disagree."""
    hosts = {}
    for m in members:
        host = re.sub(r'^https?://([^/?#]+).*$', r'\1', m.get('url') or '').lower()
        if host:
            hosts[host] = hosts.get(host, 0) + 1
    if not hosts:
        return None
    host, n = max(hosts.items(), key=lambda kv: (kv[1], -len(kv[0])))
    return 'https://%s/' % host if n * 5 >= len(members) * 2 else None


def parties(members):
    out = {}
    for m in members:
        if m.get('party'):
            out[m['party']] = out.get(m['party'], 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def summary(st, members, source_updated, retrieved):
    _, _, upper, lower = districts.STATES[st]
    chambers = []
    for cid, seats in (('upper', upper), ('lower', lower)):
        if not seats:
            continue
        ids = ('upper', 'legislature') if cid == 'upper' else ('lower',)
        mine = [m for m in members if m['chamber'] in ids]
        n = len(mine)
        chambers.append({'id': 'legislature' if st in ('NE', 'DC') else cid, 'name': districts.chamber_label(st, cid),
                         'seats': seats, 'members': n, 'vacant': max(0, seats - n), 'parties': parties(mine),
                         'official_site': official_site(mine)})
    return {'state': st, 'schema_version': SCHEMA, 'legislature': districts.legislature_name(st), 'chambers': chambers,
            'source': {'id': 'openstates-people', 'name': 'Open States (Plural), current legislators',
                       'url': 'https://open.pluralpolicy.com/data/legislator-csv/', 'official': False},
            'source_updated_at': source_updated, 'retrieved_at': retrieved,
            'session': None, 'latest': []}


SHRINK = 0.8     # a state's file that loses more than a fifth of its legislators overnight is not published


def california_row(manifest):
    """California's legislators come from california.py; this adds its row to legislatures.json."""
    d = writer.read_json('us-ca/members.json') or {}
    active = [m for m in d.get('members') or [] if m.get('active')]
    if not active:
        return None
    src = manifest.data.get('sources', {}).get('ca-leginfo-pubinfo') or {}
    _, _, upper, lower = districts.STATES['CA']
    return {'members': len(active), 'seats': upper + lower, 'vacant': len(d.get('vacant') or []),
            'source': 'ca-leginfo-pubinfo', 'official': True, 'source_updated_at': src.get('source_updated_at')}


def main(argv=None):
    http = Http()
    manifest = Manifest()
    sid = 'openstates-people'
    manifest.describe(sid, 'Open States (Plural): current state legislators', 'https://open.pluralpolicy.com/data/legislator-csv/',
                      'state', official=False, license='Public domain')
    only = [s.strip().upper() for s in os.environ.get('LEGIS_STATES', '').split(',') if s.strip()]
    allow_shrink = bool(os.environ.get('ALLOW_SHRINK'))
    prev_index = (writer.read_json('legislatures.json') or {}).get('states') or {}
    index = {}
    ok, failed, total, newest, unmatched_total = [], [], 0, None, 0
    search_rows, prev_search = {}, {}
    for r in (writer.read_json('search/states.json') or {}).get('rows') or []:
        prev_search.setdefault(r[4].split('-')[1].upper(), []).append(r)
    for st in sorted(districts.STATES):
        if st == 'CA' or (only and st not in only):
            continue
        rel = 'us-%s/members.json' % st.lower()
        prev = writer.read_json(rel) or {}
        prev_n = len(prev.get('members') or [])
        geo = writer.read_json('geo/us-%s/counties.json' % st.lower()) or {}
        aliases = (geo.get('districts') or {}).get('aliases') or {}
        try:
            text, meta = http.get_text(PEOPLE % st.lower(), ttl=20 * 3600)
            members, unmatched = parse_people(text, st, aliases, county_name_index(geo))
            if not members:
                raise RuntimeError('no legislators in the file')
            if prev_n and len(members) < prev_n * SHRINK and not allow_shrink:
                raise RuntimeError('%d legislators, %d last night; kept the previous file' % (len(members), prev_n))
        except Exception as e:
            failed.append('%s (%s)' % (st, str(e)[:80]))
            print('   %s: %s' % (st, e))
            total += prev_n
            if st in prev_index:
                index[st] = prev_index[st]
            search_rows[st] = prev_search.get(st) or []
            continue
        updated = http_date_to_iso(meta.get('last_modified'))
        newest = max(newest or '', updated or '') or None
        retrieved = now_iso()
        writer.write_json(rel, {'schema_version': SCHEMA, 'state': st, 'members': members,
                                'source_updated_at': updated, 'retrieved_at': retrieved})
        prev_summary = writer.read_json('us-%s/summary.json' % st.lower()) or {}
        summ = summary(st, members, updated, retrieved)
        for k in ('session', 'latest'):
            if prev_summary.get(k):
                summ[k] = prev_summary[k]          # phase 2 fills these; keep them when only members refresh
        writer.write_json('us-%s/summary.json' % st.lower(), summ)
        search_rows[st] = [['member', m['id'], m['name'], ' · '.join(x for x in (m['party'], district_words(m)) if x), m['body']] for m in members]
        row = dict(prev_index.get(st) or {})
        row.update({'members': len(members), 'seats': sum(c['seats'] for c in summ['chambers']),
                    'vacant': sum(c['vacant'] for c in summ['chambers']), 'unmatched': unmatched,
                    'source': sid, 'official': False, 'source_updated_at': updated})
        index[st] = row
        ok.append(st)
        total += len(members)
        unmatched_total += unmatched
        if unmatched:
            print('   %s: %d of %d legislators not matched to a Census district' % (st, unmatched, len(members)))
    ca = california_row(manifest)
    if ca:
        index['CA'] = ca
    if only:
        for st, row in prev_index.items():
            index.setdefault(st, row)
    writer.write_json('legislatures.json', {'schema_version': SCHEMA, 'generated_at': now_iso(), 'states': index})
    # Every state's legislators in one file, for the search page (California's are in search/us-ca.json).
    # meta is party and district; the page names the state and chamber from the body.
    if only:
        for st, rows in prev_search.items():
            search_rows.setdefault(st, rows)
    writer.write_json('search/states.json', {'schema_version': SCHEMA, 'columns': ['type', 'id', 'label', 'meta', 'body'],
                                             'rows': [r for st in sorted(search_rows) for r in search_rows[st]]})
    note = '%d legislatures, %d legislators' % (len(ok), total)
    if unmatched_total:
        note += '; %d not matched to a district' % unmatched_total
    if failed and ok:
        manifest.partial(sid, 'failed: ' + ', '.join(failed), source_updated_at=newest, note=note)
    elif failed:
        manifest.error(sid, 'failed: ' + ', '.join(failed))
    else:
        manifest.ok(sid, source_updated_at=newest, note=note)
    if not only:
        manifest.count('st_members', total)
    manifest.save()
    print('   %s' % note)


if __name__ == '__main__':
    main()
