"""
Federal legislator identity from the congress-legislators project (CC0).

https://unitedstates.github.io/congress-legislators/legislators-current.json
is the hub that ties the House Clerk's bioguide IDs, the Senate's LIS IDs and
Wikidata together. It is community maintained, so it is labelled as such in
the manifest, but every ID in it comes from the official sources it links.
"""

LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json'
SENATE_MEMBERS_URL = 'https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml'
HISTORICAL_URL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.json'
TERRITORIES = {'DC', 'PR', 'GU', 'VI', 'AS', 'MP'}
PARTY = {'Democrat': 'D', 'Republican': 'R', 'Independent': 'I', 'Libertarian': 'L'}


def _record(m, term):
    """One member record from a congress-legislators person and the term that applies."""
    bioguide = m['id'].get('bioguide')
    chamber = 'us-house' if term['type'] == 'rep' else 'us-senate'
    district = term.get('district')
    return {
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
            'congress_gov': 'https://www.congress.gov/member/%s/%s' % (_slug_name(m['name']), bioguide),
            'bioguide': 'https://bioguide.congress.gov/search/bio/%s' % bioguide,
        }.items() if v},
        'phone': term.get('phone'),
    }


def load_members(http, manifest):
    sid = 'congress-legislators'
    manifest.describe(sid, 'congress-legislators (unitedstates project)', LEGISLATORS_URL, 'federal',
                      official=False, license='CC0 1.0')
    data, meta = http.get_json(LEGISLATORS_URL, ttl=6 * 3600)
    members = {}
    for m in data:
        if not m['id'].get('bioguide'):
            continue
        rec = _record(m, m['terms'][-1])
        members[rec['id']] = rec
    manifest.ok(sid, source_updated_at=_last_modified(meta))
    return members


def apply_senate_roster(http, manifest, members):
    """The Senate's own member file is the official map from LIS ids (used in Senate vote XML) to
    bioguide ids. It fills LIS ids congress-legislators lacks and adds senators that file has not
    caught up with yet, such as new appointees. Returns how many senators were added."""
    import xml.etree.ElementTree as ET
    sid = 'senate-member-data'
    manifest.describe(sid, 'U.S. Senate member data (LIS ids to bioguide ids)', SENATE_MEMBERS_URL, 'federal')
    try:
        body, meta = http.get(SENATE_MEMBERS_URL, ttl=12 * 3600)
        root = ET.fromstring(body)
    except Exception as e:
        manifest.error(sid, e)
        print('   senate member data unavailable: %s' % e)
        return 0
    added = 0
    for s in root.findall('senator'):
        lis = (s.get('lis_member_id') or '').strip()
        bio = (s.findtext('bioguideId') or '').strip()
        if not lis or not bio:
            continue
        if bio in members:
            members[bio].setdefault('ids', {})['lis'] = lis
            continue
        first = ' '.join((s.findtext('name/first') or '').split())
        last = ' '.join((s.findtext('name/last') or '').split())
        members[bio] = {'id': bio, 'level': 'federal', 'jurisdiction': 'us', 'body': 'us-senate',
                        'name': ('%s %s' % (first, last)).strip(), 'first': first, 'last': last,
                        'party': (s.findtext('party') or '').strip(), 'state': (s.findtext('state') or '').strip(),
                        'district': None, 'delegate': False, 'ids': {'bioguide': bio, 'lis': lis},
                        'urls': {'bioguide': 'https://bioguide.congress.gov/search/bio/%s' % bio}}
        added += 1
    updated = None
    try:
        # <lastUpdate><date>Sunday, September 27, 2026</date><time>5:00:13 AM EDT</time></lastUpdate>
        from datetime import datetime
        from .common import iso, EASTERN
        stamp = '%s %s' % (' '.join((root.findtext('lastUpdate/date') or '').split()),
                           ' '.join((root.findtext('lastUpdate/time') or '').replace('EDT', '').replace('EST', '').split()))
        updated = iso(datetime.strptime(stamp, '%A, %B %d, %Y %I:%M:%S %p').replace(tzinfo=EASTERN))
    except ValueError:
        pass
    manifest.ok(sid, source_updated_at=updated or _last_modified(meta), note='%d senators; %d added that congress-legislators lacked' % (len(root.findall('senator')), added))
    return added


def resolve_departed(http, manifest, members, votes):
    """Members who voted in this Congress but are not in legislators-current (they died, resigned or
    took another office) arrive from the vote XML with only a surname. The historical file names them
    properly; Senate positions recorded under a LIS id are rewritten to the bioguide id."""
    missing = [k for k, m in members.items() if m.get('provisional')]
    if not missing:
        return 0
    sid = 'congress-legislators-historical'
    manifest.describe(sid, 'congress-legislators historical members (unitedstates project)', HISTORICAL_URL, 'federal',
                      official=False, license='CC0 1.0')
    try:
        data, meta = http.get_json(HISTORICAL_URL, ttl=7 * 24 * 3600)
    except Exception as e:
        manifest.error(sid, e)
        print('   historical legislators unavailable: %s' % e)
        return 0
    by_bio, by_lis = {}, {}
    for p in data:
        if p['id'].get('bioguide'):
            by_bio[p['id']['bioguide']] = p
        if p['id'].get('lis'):
            by_lis[p['id']['lis']] = p
    rename = {}
    resolved = 0
    for k in missing:
        p = by_lis.get(k[4:]) if k.startswith('lis-') else by_bio.get(k)
        if not p:
            continue
        chamber = members[k]['body']
        terms = [t for t in p['terms'] if (t['type'] == 'rep') == (chamber == 'us-house')] or p['terms']
        rec = _record(p, terms[-1])
        rec.update({'active': False, 'former': True, 'left_office': terms[-1].get('end')})
        del members[k]
        if rec['id'] != k:
            rename[k] = rec['id']
        members.setdefault(rec['id'], rec)
        resolved += 1
    if rename:
        for v in votes:
            v['positions'] = [[rename.get(mid, mid), code] for mid, code in v['positions']]
    manifest.ok(sid, source_updated_at=_last_modified(meta), note='%d former members named' % resolved)
    return resolved


def _slug_name(name):
    from .common import slugify
    return slugify('%s %s' % (name.get('first', ''), name.get('last', '')))


def _last_modified(meta):
    from .common import http_date_to_iso
    return http_date_to_iso(meta.get('last_modified')) or meta.get('fetched_at')
