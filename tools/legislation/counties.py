"""
County boards of supervisors.

For counties on Granicus Legistar (17 of 58), the public Web API
(https://webapi.legistar.com/v1/{client}/...) gives meetings, agenda items,
per-supervisor votes and the current office holders as JSON with
*LastModifiedUtc timestamps. Every other county gets a link-only record from
counties-sources.json; each URL is checked so the site can say plainly when a
county page is unreachable. The Legistar collection itself is in legistar.py, which does the same
for counties in other states.

Output under data/legislation/us-ca/counties/:
  index.json                     every county: coverage, links, counts, next meeting
  upcoming.json                  scheduled board meetings across the Legistar counties
  {fips}/board.json              members, meetings of the last 90 days, months with votes
  {fips}/votes-{yyyy-mm}.json    one month of votes (compact rows) with the matters they decided
"""
import json
import os

from . import legistar, writer
from .common import FetchError, Http, Manifest, today

SOURCES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'counties-sources.json')
AHEAD_DAYS = 45
LIMIT = legistar.LIMIT
vote_code = legistar.vote_code
sitting = legistar.sitting
CODE_LABELS = legistar.CODE_LABELS
VOTE_COLUMNS = legistar.VOTE_COLUMNS
LATEST_COLUMNS = legistar.LATEST_COLUMNS


def load_sources():
    with open(SOURCES, encoding='utf-8') as fh:
        return json.load(fh)['counties']


def ca_boards(bodies):
    """The Board of Supervisors plus the sittings Legistar files under it ("Board of Supervisors -
    Land Use", "Special Meeting of the Board of Supervisors"); the primary body first."""
    def is_board(b):
        name = ' '.join((b.get('BodyName') or '').lower().split())
        return b.get('BodyActiveFlag', 1) and (name == 'board of supervisors' or name.startswith('board of supervisors') or name.endswith('of the board of supervisors'))
    boards = [b for b in bodies if is_board(b)]
    boards.sort(key=lambda b: (0 if ' '.join((b.get('BodyName') or '').lower().split()) == 'board of supervisors' else 1 if (b.get('BodyTypeName') or '') == 'Primary Legislative Body' else 2, b['BodyId']))
    return boards


def legistar_board(http, client, fips, county_name):
    """Meetings, items, votes and members for one California county on Legistar."""
    bodies, _ = http.get_json(legistar.API % (client, 'bodies?$top=500'), ttl=24 * 3600)
    boards = ca_boards(bodies)
    if not boards:
        raise RuntimeError('%s: no Board of Supervisors body in Legistar (%d bodies)' % (client, len(bodies)))
    title = '%s Board of Supervisors' % county_name.replace(' County', '') if fips != '06075' else 'San Francisco Board of Supervisors'
    return legistar.collect_board(http, client, 'CA', fips, county_name, boards, title, 'Supervisor', 'America/Los_Angeles')


def check_url(http, url):
    """'ok', 'blocked' (the site refuses automated requests; the page exists for people),
    or 'unreachable: ...' (not found, or no response)."""
    try:
        http.get(url, ttl=24 * 3600)
        return 'ok'
    except FetchError as e:
        msg = str(e)
        if 'HTTP 403' in msg or 'HTTP 429' in msg or 'HTTP 503' in msg or 'HTTP 401' in msg:
            return 'blocked'
        return 'unreachable: %s' % msg[:80]
    except Exception as e:
        return 'unreachable: %s' % str(e)[:80]


VOTE_COLUMNS = ['id', 'date', 'meeting_id', 'agenda_number', 'question', 'matter_id', 'result', 'passed', 'yes', 'no', 'other', 'positions', 'mover', 'seconder', 'source_updated_at']


def write_county(fips, rec, members, meetings, votes, matters):
    return legistar.write_board('us-ca/counties/%s' % fips, rec, members, meetings, votes, matters)


def links_only(http, src, rec, entry, manifest, sid):
    status = check_url(http, src.get('board_url') or src['website'])
    rec['url_status'] = entry['url_status'] = status
    rec['coverage'] = entry['coverage'] = 'links'
    if status == 'ok':
        manifest.ok(sid, note='links only')
    elif status == 'blocked':
        manifest.ok(sid, note='links only; the site blocks automated checks, so the link is not verified nightly')
    else:
        manifest.error(sid, status)
    writer.write_json('us-ca/counties/%s/board.json' % fips_of(rec), rec)


def fips_of(rec):
    return rec['fips']


def main(argv=None):
    http = Http()
    manifest = Manifest()
    sources = load_sources()
    counties = (writer.read_json('geo/us-ca/counties.json') or {}).get('counties', [])
    names = {c['fips']: c['name'] for c in counties}
    slugs = {c['fips']: c['slug'] for c in counties}
    total_votes = total_meetings = with_votes = 0
    today_s = today().isoformat()
    index, upcoming, latest = [], [], []
    only = [f for f in os.environ.get('LEGIS_COUNTIES', '').split(',') if f]    # debugging hook: a few FIPS codes
    for fips, src in sorted(sources.items()):
        if only and fips not in only:
            continue
        name = names.get(fips) or src['name']
        sid = 'county-' + fips
        manifest.describe(sid, '%s Board of Supervisors' % name, src.get('board_url') or src['website'], 'county')
        body_name = '%s Board of Supervisors' % name.replace(' County', '') if fips != '06075' else 'San Francisco Board of Supervisors'
        rec = {'fips': fips, 'county': name, 'slug': slugs.get(fips), 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
               'body_name': body_name, 'coverage': src.get('coverage', 'links'), 'platform': src.get('platform'),
               'urls': {k: src[k] for k in ('website', 'board_url', 'agenda_url') if src.get(k)},
               'members': [], 'meetings': [], 'vote_months': [], 'counts': {'meetings': 0, 'votes': 0, 'matters': 0}}
        entry = {k: rec[k] for k in ('fips', 'county', 'slug', 'body', 'body_name', 'coverage', 'platform', 'urls')}
        stale_before = len(http.stale_served)
        try:
            if src.get('legistar_client'):
                members, meetings, votes, matters = legistar_board(http, src['legistar_client'], fips, name)
                member_rows = sorted(members.values(), key=lambda m: (m.get('provisional', False), m['name']))
                meetings = sorted(meetings, key=lambda m: m['date'], reverse=True)
                rec['coverage'] = 'votes' if any(v['recorded'] for v in votes) else 'agendas'
                latest += write_county(fips, rec, member_rows, meetings, votes, matters)
                entry.update({'coverage': rec['coverage'], 'counts': rec['counts'], 'members': len([m for m in member_rows if not m.get('provisional')]),
                              'latest_meeting': max((m['date'] for m in meetings if m['date'] < today_s), default=None),
                              'next_meeting': min((m['date'] for m in meetings if m['date'] >= today_s), default=None)})
                upcoming += [dict(m, county=name, fips=fips) for m in meetings if m['date'] >= today_s]
                total_votes += len(votes); total_meetings += len(meetings); with_votes += 1 if rec['coverage'] == 'votes' else 0
                updated = max((m['source_updated_at'] for m in meetings if m.get('source_updated_at')), default=None)
                stale = len(http.stale_served) - stale_before
                if stale:
                    manifest.partial(sid, '%d requests failed; earlier copies were used' % stale, source_updated_at=updated,
                                     note='%d meetings, %d votes' % (len(meetings), len(votes)))
                else:
                    manifest.ok(sid, source_updated_at=updated, note='%d meetings, %d votes' % (len(meetings), len(votes)))
            else:
                links_only(http, src, rec, entry, manifest, sid)
        except Exception as e:
            if src.get('legistar_client') and 'HTTP 400' in str(e):
                # a Legistar client whose public API is misconfigured (San Francisco): fall back to links
                rec['api_error'] = entry['api_error'] = str(e)[:160]
                links_only(http, src, rec, entry, manifest, sid)
            else:
                manifest.error(sid, e)
                print('   %s failed: %s' % (name, e))
                old = writer.read_json('us-ca/counties/%s/board.json' % fips)
                if old:
                    entry.update({'coverage': old.get('coverage', entry['coverage']), 'counts': old.get('counts'), 'members': len(old.get('members') or [])})
                else:
                    writer.write_json('us-ca/counties/%s/board.json' % fips, rec)
        if src.get('note'):
            rec['note'] = entry['note'] = src['note']
            if not rec.get('members'):
                writer.write_json('us-ca/counties/%s/board.json' % fips, rec)
        index.append(entry)
    upcoming.sort(key=lambda m: (m['date'], m.get('time') or '', m['county']))
    writer.write_json('us-ca/counties/index.json', {'counties': index, 'legistar': sum(1 for e in index if e.get('platform') == 'Legistar')})
    writer.write_json('us-ca/counties/upcoming.json', {'items': upcoming})
    if not only:
        # the most recent recorded votes across every county (roll calls first, then other actions)
        latest.sort(key=lambda r: (r[1], r[12], r[0]), reverse=True)
        writer.write_json('us-ca/counties/latest.json', {'columns': LATEST_COLUMNS, 'rows': [r for r in latest if r[12]][:40]})
    manifest.count('ca_counties_with_votes', with_votes)
    manifest.count('ca_county_votes', total_votes)
    manifest.count('ca_county_meetings', total_meetings)
    manifest.save()
    print('   %d counties; %d with machine-readable votes; %d meetings, %d votes' % (len(sources), with_votes, total_meetings, total_votes))


if __name__ == '__main__':
    main()
