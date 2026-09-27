#!/usr/bin/env python3
"""
Build studenttrustee.net from templates and data.

    python3 tools/build.py            # render everything into studenttrustee/
    python3 tools/build.py --check    # exit 1 if the committed output is stale

Inputs
  studenttrustee/data/roster.json   the trustee roster (single source of truth)
  studenttrustee/data/site.json     origin, verification dates, maintainer
  tools/templates/                  Jinja2 templates (base.html + pages/)

Outputs (all committed, so Netlify stays build-less)
  studenttrustee/index.html, map.html, legislature.html, about.html
  studenttrustee/districts/index.html and districts/<slug>/index.html (72)
  studenttrustee/sitemap.xml, robots.txt

The build is deterministic: the same inputs always produce byte-identical
output, which is what lets CI check that the committed pages are fresh.
"""
import json
import os
import re
import sys
import unicodedata

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'studenttrustee')
DATA = os.path.join(SITE, 'data')
TEMPLATES = os.path.join(ROOT, 'tools', 'templates')

REGIONS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
REGION_NAME = {
    'I': 'Far North', 'II': 'Sacramento & North Valley', 'III': 'East & North Bay',
    'IV': 'South Bay & Central Coast', 'V': 'Central Valley', 'VI': 'South Central Coast',
    'VII': 'Los Angeles', 'VIII': 'Orange County & San Gabriel',
    'IX': 'Inland Empire & Desert', 'X': 'San Diego & Imperial',
}
REGION_HEX = {
    'I': '#eda100', 'II': '#4a3aa7', 'III': '#1baf7a', 'IV': '#9c27b0', 'V': '#008300',
    'VI': '#e87ba4', 'VII': '#2a78d6', 'VIII': '#eb6834', 'IX': '#0e8fae', 'X': '#e34948',
}

# Nav is defined once. The Legislation tab replaces the old Legislature page when it ships.
NAV = [('/', 'Home'), ('/map', 'District map'), ('/districts/', 'Districts'),
       ('/legislature', 'Legislature'), ('/about', 'About')]


def slug(s):
    """Byte-for-byte the same slug map.js uses, so #d= deep links still match."""
    s = unicodedata.normalize('NFD', s.lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9]+', '-', s)
    return s.strip('-')


def stamp(iso):
    months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December']
    y, m, d = (int(x) for x in iso.split('-'))
    return '%d %s %d' % (d, months[m - 1], y)


def stamp_us(iso):
    months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December']
    y, m, d = (int(x) for x in iso.split('-'))
    return '%s %d, %d' % (months[m - 1], d, y)


def load_json(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as fh:
        return json.load(fh)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text if text.endswith('\n') else text + '\n')


def json_ld(d, origin):
    node = {
        '@context': 'https://schema.org',
        '@type': 'GovernmentOrganization',
        'name': d['name'],
        'url': '%s/districts/%s/' % (origin, d['slug']),
        'areaServed': {'@type': 'AdministrativeArea',
                       'name': 'Region %s, California Community Colleges' % d['region']},
        'address': {'@type': 'PostalAddress', 'addressRegion': 'CA', 'addressCountry': 'US'},
    }
    if d.get('web'):
        node['sameAs'] = [d['web']]
    if d.get('colleges'):
        node['subOrganization'] = [{'@type': 'CollegeOrUniversity', 'name': c} for c in d['colleges']]
    members = []
    for p in d.get('trustees') or []:
        m = {'@type': 'Person', 'name': ('%s %s' % (p['first'], p['last'])).strip(), 'jobTitle': 'Student Trustee'}
        if p.get('email'):
            m['email'] = p['email']
        members.append({'@type': 'OrganizationRole', 'roleName': 'Student Trustee', 'member': m})
    if members:
        node['member'] = members
    return json.dumps(node, ensure_ascii=False, separators=(',', ':'))


def who_line(d):
    people = d.get('trustees') or []
    if people:
        return ', '.join(('%s %s' % (p['first'], p['last'])).strip() for p in people)
    if d.get('seat') == 'vacant':
        return 'Seat vacant'
    return 'Not listed'


def main(check=False):
    site = load_json('site.json')
    roster = load_json('roster.json')
    origin = site['origin']
    districts = sorted(roster['districts'], key=lambda d: d['name'])
    seen = {}
    for d in districts:
        d['slug'] = slug(d['name'])
        d['who'] = who_line(d)
        if d['slug'] in seen:
            sys.exit('slug collision: %r and %r both give %r' % (seen[d['slug']], d['name'], d['slug']))
        seen[d['slug']] = d['name']

    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(['html']),
                      trim_blocks=False, lstrip_blocks=False, keep_trailing_newline=True)

    filled = sum(1 for d in districts if d.get('trustees'))
    trustees = sum(len(d.get('trustees') or []) for d in districts)
    empty = [d for d in districts if not d.get('trustees')]
    vacant = [d['name'].replace(' CCD', '') for d in empty if d.get('seat') == 'vacant']
    unlisted = [d['name'].replace(' CCD', '') for d in empty if d.get('seat') != 'vacant']
    vacant_sentence = ''
    if vacant:
        vacant_sentence += '%s confirmed vacant by the district (%s). ' % (
            ['One is', 'Two are', 'Three are', 'Four are', 'Five are'][min(len(vacant), 5) - 1], ', '.join(vacant))
    if unlisted:
        vacant_sentence += '%s no student member at all (%s).' % (
            ['One publishes', 'Two publish', 'Three publish', 'Four publish', 'Five publish'][min(len(unlisted), 5) - 1], ', '.join(unlisted))

    common = {
        'site': site, 'nav': NAV, 'regions': REGIONS, 'region_name': REGION_NAME, 'region_hex': REGION_HEX,
        'roster_stamp': stamp(site['last_verified']), 'verified_stamp': stamp(site['last_verified']),
        'roster_as_of': stamp_us(site['roster_as_of']), 'corrections_through': stamp_us(site['corrections_through']),
        'nav_legislation_href': '/legislature', 'nav_legislation_cta': 'Legislative calendars',
        'door_legislation_title': 'Legislatures',
        'door_legislation_text': "Track California's 2026 legislative deadlines and the weeks when the U.S. House and Senate are in session.",
    }

    outputs = {}

    def render(template, path, **ctx):
        outputs[path] = env.get_template(template).render(**common, **ctx)

    render('pages/home.html', 'index.html', current='/',
           title='California Student Trustees | All 72 Community College Districts',
           description='An interactive map of all 72 California community college districts, their boundaries, and the student trustees who represent them.',
           og_title='studenttrustee.net — every student trustee in California',
           og_description='72 community college districts, drawn to their real boundaries, each with the student who sits on its board.',
           canonical=origin + '/',
           stats={'trustees': trustees, 'filled': filled, 'districts': len(districts), 'empty': len(empty), 'vacant_sentence': vacant_sentence.strip()})

    roster_json = json.dumps({'districts': districts, 'totalTrustees': roster.get('totalTrustees'),
                              'sourceFile': roster.get('sourceFile')}, ensure_ascii=False, separators=(',', ':'))
    roster_json = roster_json.replace('</', '<\\/')   # never let the JSON close its own script tag
    render('pages/map.html', 'map.html', current='/map',
           title='Student Trustee Map | All 72 California Community College Districts',
           description='An interactive map of all 72 California community college districts, their boundaries, and the student trustees who represent them — grouped by SSCCC Region I–X.',
           og_title='California Student Trustees — District Map',
           og_description='All 72 California community college districts, their real boundaries, and the student trustees who represent them — grouped by SSCCC Region I–X.',
           canonical=origin + '/map', roster_json=roster_json)

    render('pages/legislature.html', 'legislature.html', current='/legislature',
           title='Legislative Calendars · California & Congress | Who Represents You',
           description='The 2026 California legislative calendar, a House-vs-Senate comparison of the congressional calendar, and direct links to find your state and federal representatives.',
           og_title='Legislative Calendars · California & Congress',
           og_description='2026 California session deadlines, where the House and Senate calendars differ, and how to find your representatives.',
           canonical=origin + '/legislature')

    render('pages/about.html', 'about.html', current='/about',
           title='About | studenttrustee.net',
           description='Nick Bonasera, Student Trustee for the Contra Costa Community College District, on why this site exists and how to reach him.',
           canonical=origin + '/about')

    render('pages/districts_index.html', 'districts/index.html', current='/districts/',
           title='All 72 California Community College Districts | studenttrustee.net',
           description='Every California community college district and its student trustee, grouped by region. One page per district.',
           canonical=origin + '/districts/', districts=districts)

    for i, d in enumerate(districts):
        people = d.get('trustees') or []
        if people:
            who = ' and '.join(('%s %s' % (p['first'], p['last'])).strip() for p in people)
            desc = ('%s is the student trustee for %s. Contact details, the colleges in the district, and the board page.' % (who, d['name'])
                    if len(people) == 1 else
                    '%s are the student trustees for %s. Contact details, the colleges in the district, and the board page.' % (who, d['name']))
        else:
            desc = '%s has no student trustee listed in the current roster. The colleges in the district and its board page.' % d['name']
        render('pages/district.html', 'districts/%s/index.html' % d['slug'], current='/districts/',
               title='%s Student Trustee | studenttrustee.net' % d['name'], description=desc,
               canonical='%s/districts/%s/' % (origin, d['slug']),
               d=d, prev=districts[i - 1] if i else None, next=districts[i + 1] if i + 1 < len(districts) else None,
               json_ld=json_ld(d, origin))

    # sitemap + robots. lastmod is the roster verification date so the file only changes when the data does.
    lastmod = site['last_verified']
    urls = [('/', '1.0'), ('/map', '0.9'), ('/districts/', '0.9'), ('/legislature', '0.7'), ('/about', '0.6')]
    urls += [('/districts/%s/' % d['slug'], '0.8') for d in districts]
    body = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, pri in urls:
        body.append('  <url><loc>%s%s</loc><lastmod>%s</lastmod><priority>%s</priority></url>' % (origin, path, lastmod, pri))
    body.append('</urlset>')
    outputs['sitemap.xml'] = '\n'.join(body) + '\n'
    outputs['robots.txt'] = 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' % origin

    stale = []
    for rel, text in outputs.items():
        path = os.path.join(SITE, rel)
        text = text if text.endswith('\n') else text + '\n'
        if check:
            try:
                with open(path, encoding='utf-8') as fh:
                    if fh.read() != text:
                        stale.append(rel)
            except FileNotFoundError:
                stale.append(rel)
        else:
            write(path, text)

    if check:
        if stale:
            print('stale output (run python3 tools/build.py):\n  ' + '\n  '.join(stale))
            sys.exit(1)
        print('build output is fresh (%d files)' % len(outputs))
    else:
        print('%d files written: %d district pages + index, home, map, legislature, about, sitemap, robots'
              % (len(outputs), len(districts)))
        print('%d trustees across %d of %d districts' % (trustees, filled, len(districts)))


if __name__ == '__main__':
    main(check='--check' in sys.argv)
