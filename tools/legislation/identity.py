"""
Federal legislator identity from the congress-legislators project (CC0).

https://unitedstates.github.io/congress-legislators/legislators-current.json
is the hub that ties the House Clerk's bioguide IDs, the Senate's LIS IDs and
Wikidata together. It is community maintained, so it is labelled as such in
the manifest, but every ID in it comes from the official sources it links.
"""
from .common import iso

LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json'
TERRITORIES = {'DC', 'PR', 'GU', 'VI', 'AS', 'MP'}
PARTY = {'Democrat': 'D', 'Republican': 'R', 'Independent': 'I', 'Libertarian': 'L'}


def load_members(http, manifest):
    sid = 'congress-legislators'
    manifest.describe(sid, 'congress-legislators (unitedstates project)', LEGISLATORS_URL, 'federal',
                      official=False, license='CC0 1.0')
    data, meta = http.get_json(LEGISLATORS_URL, ttl=6 * 3600)
    members = {}
    for m in data:
        term = m['terms'][-1]
        bioguide = m['id'].get('bioguide')
        if not bioguide:
            continue
        chamber = 'us-house' if term['type'] == 'rep' else 'us-senate'
        district = term.get('district')
        rec = {
            'id': bioguide,
            'level': 'federal',
            'jurisdiction': 'us',
            'body': chamber,
            'name': m['name'].get('official_full') or ('%s %s' % (m['name']['first'], m['name']['last'])),
            'first': m['name']['first'],
            'last': m['name']['last'],
            'party': PARTY.get(term.get('party'), (term.get('party') or '')[:1]),
            'party_name': term.get('party'),
            'state': term['state'],
            'district': district if district is None else int(district),
            'delegate': term['type'] == 'rep' and term['state'] in TERRITORIES,
            'term_start': term.get('start'),
            'term_end': term.get('end'),
            'ids': {k: v for k, v in {
                'bioguide': bioguide, 'lis': m['id'].get('lis'), 'wikidata': m['id'].get('wikidata'),
                'govtrack': m['id'].get('govtrack'), 'opensecrets': m['id'].get('opensecrets'),
            }.items() if v},
            'urls': {k: v for k, v in {
                'official': term.get('url'), 'contact': term.get('contact_form'),
                'congress_gov': 'https://www.congress.gov/member/%s/%s' % (
                    _slug_name(m['name']), bioguide),
                'bioguide': 'https://bioguide.congress.gov/search/bio/%s' % bioguide,
            }.items() if v},
            'phone': term.get('phone'),
        }
        members[bioguide] = rec
    manifest.ok(sid, source_updated_at=_last_modified(meta))
    return members


def _slug_name(name):
    from .common import slugify
    return slugify('%s %s' % (name.get('first', ''), name.get('last', '')))


def _last_modified(meta):
    from .common import http_date_to_iso
    return http_date_to_iso(meta.get('last_modified')) or meta.get('fetched_at')
