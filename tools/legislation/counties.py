"""
County boards of supervisors.

For counties on Granicus Legistar (11 confirmed), the public Web API
(https://webapi.legistar.com/v1/{client}/...) gives meetings, agenda items,
per-supervisor votes and the current office holders as JSON with
*LastModifiedUtc timestamps. Every other county gets a link-only record from
counties-sources.json; each URL is checked so the site can say plainly when a
county page is unreachable.

Output under data/legislation/us-ca/counties/:
  index.json                     every county: coverage, links, counts, next meeting
  upcoming.json                  scheduled board meetings across the Legistar counties
  {fips}/board.json              members, meetings of the last 90 days, months with votes
  {fips}/votes-{yyyy-mm}.json    one month of votes (compact rows) with the matters they decided
"""
import json
import os
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import writer
from .common import Http, Manifest, iso, clock, clock_note, FetchError, UTC

API = 'https://webapi.legistar.com/v1/%s/%s'
SOURCES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'counties-sources.json')
LOOKBACK_DAYS = 90
AHEAD_DAYS = 45
# Each county names its vote values differently (seen: Aye/Ayes/AYE/Yes, Nay/Noes/NO/No, Absent,
# NOT PRESENT, Recuse/Recused, Abstain/Abstained). Anything unrecognised is kept as O (other).
VOTE_CODES = {'AYE': 'Y', 'AYES': 'Y', 'YES': 'Y', 'YEA': 'Y', 'YEAS': 'Y',
              'NO': 'N', 'NOES': 'N', 'NAY': 'N', 'NAYS': 'N',
              'ABSTAIN': 'A', 'ABSTAINED': 'A', 'ABSTENTION': 'A',
              'ABSENT': 'X', 'EXCUSED': 'X', 'NOT VOTING': 'X', 'NOT PRESENT': 'X', 'DID NOT VOTE': 'X',
              'RECUSED': 'R', 'RECUSE': 'R', 'RECUSAL': 'R', 'PRESENT': 'P'}


def vote_code(label):
    return VOTE_CODES.get(' '.join((label or '').upper().split()), 'O')
LIMIT = int(os.environ.get('LEGIS_LIMIT', '0') or 0)


def today():
    """Test hook: LEGIS_TODAY=YYYY-MM-DD pins the clock."""
    t = os.environ.get('LEGIS_TODAY')
    return date.fromisoformat(t) if t else date.today()
CODE_LABELS = {'Y': 'aye', 'N': 'no', 'A': 'abstain', 'X': 'absent or not voting', 'R': 'recused', 'P': 'present', 'O': 'other', '-': 'not on this roll'}


def load_sources():
    with open(SOURCES, encoding='utf-8') as fh:
        return json.load(fh)['counties']


def utc(value):
    """Legistar '2026-09-03T21:48:39.187' (UTC, no offset) or '2026-09-01T00:00:00' dates."""
    if not value:
        return None
    m = re.match(r'(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})', value)
    if not m:
        return value
    return iso(datetime.strptime(m.group(1) + 'T' + m.group(2), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=UTC))


def sitting(body_name):
    """'BOARD OF SUPERVISORS - LAND USE' -> 'Land Use'; the plain board -> ''."""
    n = ' '.join((body_name or '').split())
    low = n.lower()
    if low == 'board of supervisors':
        return ''
    rest = re.sub(r'(?i)^board of supervisors\s*[-:–]?\s*', '', n)
    rest = re.sub(r'(?i)\s*of the board of supervisors$', '', rest)
    return rest.title() if rest.isupper() else rest


def legistar_board(http, client, fips, county_name):
    """Meetings, items, votes and members for one Legistar client. Raises on hard failure."""
    bodies, _ = http.get_json(API % (client, 'bodies?$top=500'), ttl=24 * 3600)
    # The board itself plus the sittings Legistar files under it ("Board of Supervisors - Land Use",
    # "Special Meeting of the Board of Supervisors"); the primary body comes first.
    def is_board(b):
        name = ' '.join((b.get('BodyName') or '').lower().split())
        return b.get('BodyActiveFlag', 1) and (name == 'board of supervisors' or name.startswith('board of supervisors') or name.endswith('of the board of supervisors'))
    boards = [b for b in bodies if is_board(b)]
    boards.sort(key=lambda b: (0 if ' '.join((b.get('BodyName') or '').lower().split()) == 'board of supervisors' else 1 if (b.get('BodyTypeName') or '') == 'Primary Legislative Body' else 2, b['BodyId']))
    if not boards:
        raise RuntimeError('%s: no Board of Supervisors body in Legistar (%d bodies)' % (client, len(bodies)))
    body_id = boards[0]['BodyId']

    since = (today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    events = []
    for b in boards:
        try:
            evs, _ = http.get_json(API % (client, "events?$filter=EventBodyId eq %d and EventDate ge datetime'%s'&$orderby=EventDate desc&$top=200" % (b['BodyId'], since)), ttl=0)
        except FetchError as e:
            if b is boards[0]:
                raise
            print('   %s: %s events skipped: %s' % (client, b.get('BodyName'), e))
            continue
        for ev in evs:
            ev['_body_name'] = (b.get('BodyName') or '').strip()
        events += evs
    events.sort(key=lambda ev: ev.get('EventDate') or '', reverse=True)
    if LIMIT:
        events = events[:max(2, LIMIT // 5)]
    # the API ignores $filter on officerecords, so the current members are picked out here
    records, _ = http.get_json(API % (client, "bodies/%d/officerecords?$filter=OfficeRecordEndDate ge datetime'%s'&$top=100" % (body_id, today().isoformat())), ttl=24 * 3600)
    today_s = today().isoformat()
    members = {}
    for r in sorted(records, key=lambda r: r.get('OfficeRecordStartDate') or ''):
        pid = r.get('OfficeRecordPersonId')
        start, end = (r.get('OfficeRecordStartDate') or '')[:10], (r.get('OfficeRecordEndDate') or '')[:10]
        if not pid or (end and end < today_s) or (start and start > today_s):
            continue
        mid = 'ca-%s-bos-%s' % (fips, pid)
        members[mid] = {'id': mid, 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
                        'name': (r.get('OfficeRecordFullName') or '').strip(), 'first': r.get('OfficeRecordFirstName'), 'last': r.get('OfficeRecordLastName'),
                        'title': (r.get('OfficeRecordTitle') or '').strip() or 'Supervisor', 'state': 'CA', 'county': county_name,
                        'term_start': start or None, 'term_end': end or None,
                        'ids': {'legistar_person': pid}, 'urls': {'official': 'https://%s.legistar.com/People.aspx' % client},
                        'source_updated_at': utc(r.get('OfficeRecordLastModifiedUtc'))}
    name_to_id = {m['name'].lower(): mid for mid, m in members.items()}

    meetings, votes, matters = [], [], {}
    far = (today() + timedelta(days=400)).isoformat()
    for ev in events:
        ev_date = (ev.get('EventDate') or '')[:10]
        eid = ev['EventId']
        if not ev_date or ev_date > far:
            continue     # Legistar template events dated 2099 and the like
        meeting = {'id': 'ca-%s-bos-meeting-%s' % (fips, eid), 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
                   'kind': 'meeting', 'date': ev_date, 'time': clock(ev.get('EventTime')), 'time_note': clock_note(ev.get('EventTime')), 'tz': 'America/Los_Angeles',
                   'title': ('%s Board of Supervisors' % county_name.replace(' County', '') if fips != '06075' else 'San Francisco Board of Supervisors') + (' (%s)' % sitting(ev['_body_name']) if sitting(ev['_body_name']) else ''),
                   'location': (ev.get('EventLocation') or '').strip() or None,
                   'status': 'scheduled' if ev_date >= today_s else 'held',
                   'official_url': ev.get('EventInSiteURL') or ('https://%s.legistar.com/Calendar.aspx' % client),
                   'agenda_url': ev.get('EventAgendaFile'), 'minutes_url': ev.get('EventMinutesFile'),
                   'source': {'id': 'legistar-' + client, 'name': '%s Legistar' % county_name, 'url': API % (client, 'events/%s' % eid)},
                   'source_updated_at': utc(ev.get('EventLastModifiedUtc')), 'items': 0, 'votes': 0}
        past = ev_date < today_s
        try:
            items, _ = http.get_json(API % (client, 'events/%s/eventitems?AgendaNote=1&MinutesNote=1&Attachments=0' % eid), ttl=(7 * 24 * 3600 if past and ev.get('EventMinutesFile') else 0))
        except FetchError as e:
            print('   %s event %s items skipped: %s' % (client, eid, e))
            items = []
        meeting['items'] = len(items)
        for it in items:
            action = (it.get('EventItemActionName') or '').strip()
            passed_flag = it.get('EventItemPassedFlagName')
            mid = it.get('EventItemMatterId')
            if mid and mid not in matters:
                matters[mid] = {'id': 'ca-%s-bos-matter-%s' % (fips, mid), 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
                                'label': (it.get('EventItemMatterFile') or '').strip() or ('Item %s' % mid), 'title': (it.get('EventItemTitle') or '').strip(),
                                'type': (it.get('EventItemMatterType') or '').strip() or None, 'status': (it.get('EventItemMatterStatus') or '').strip() or None,
                                'official_url': 'https://%s.legistar.com/LegislationDetail.aspx?ID=%s' % (client, mid), 'vote_ids': [],
                                'source': {'id': 'legistar-' + client, 'name': '%s Legistar' % county_name, 'url': API % (client, 'matters/%s' % mid)},
                                'source_updated_at': utc(it.get('EventItemLastModifiedUtc'))}
            if not action and not passed_flag:
                continue
            positions, labels = [], {}
            if past:
                try:
                    vrows, _ = http.get_json(API % (client, 'eventitems/%s/votes' % it['EventItemId']), ttl=30 * 24 * 3600)
                except FetchError:
                    vrows = []
                for vr in vrows:
                    label = (vr.get('VoteValueName') or '').strip()
                    code = vote_code(label)
                    labels.setdefault(code, label)
                    pid = vr.get('VotePersonId')
                    member = 'ca-%s-bos-%s' % (fips, pid) if pid else name_to_id.get((vr.get('VotePersonName') or '').lower(), 'ca-%s-bos-unknown' % fips)
                    if member not in members and pid:
                        members[member] = {'id': member, 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
                                           'name': (vr.get('VotePersonName') or '').strip(), 'title': 'Supervisor (former)', 'state': 'CA', 'county': county_name,
                                           'ids': {'legistar_person': pid}, 'urls': {}, 'provisional': True}
                    positions.append([member, code])
            yes = sum(1 for p in positions if p[1] == 'Y'); no = sum(1 for p in positions if p[1] == 'N')
            other = len(positions) - yes - no
            result = passed_flag or action
            vote = {'id': 'ca-%s-bos-vote-%s-%s' % (fips, ev_date.replace('-', ''), it['EventItemId']), 'level': 'county', 'jurisdiction': 'us-ca-%s' % fips, 'body': 'ca-%s-bos' % fips,
                    'meeting_id': meeting['id'], 'date': ev_date, 'time': meeting['time'], 'tz': 'America/Los_Angeles',
                    'question': action or ('Passed' if passed_flag == 'Pass' else result), 'title': ('%s: %s' % ((it.get('EventItemMatterFile') or '').strip(), (it.get('EventItemTitle') or '').strip())).strip(': '),
                    'agenda_number': (it.get('EventItemAgendaNumber') or '').strip() or None,
                    'result': result, 'passed': (passed_flag or '').lower().startswith('pass') or bool(re.search(r'adopt|approv|pass|carried', action, re.I)),
                    'tally': {'yes': yes, 'no': no, 'present': 0, 'not_voting': other}, 'recorded': bool(positions),
                    'mover': (it.get('EventItemMover') or '').strip() or None, 'seconder': (it.get('EventItemSeconder') or '').strip() or None,
                    'bill_id': matters[mid]['id'] if mid in matters else None, 'bill_label': matters[mid]['label'] if mid in matters else None,
                    'labels': labels, 'positions': positions,
                    'official_url': meeting['minutes_url'] or meeting['official_url'],
                    'source': {'id': 'legistar-' + client, 'name': '%s Legistar' % county_name, 'url': API % (client, 'eventitems/%s/votes' % it['EventItemId'])},
                    'source_updated_at': utc(it.get('EventItemLastModifiedUtc'))}
            votes.append(vote)
            meeting['votes'] += 1
            if mid in matters:
                matters[mid]['vote_ids'].append(vote['id'])
        meetings.append(meeting)
    return members, meetings, votes, matters


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
    """board.json plus one compact vote file per month. positions is a string in board member order."""
    order = [m['id'] for m in members]
    by_month = defaultdict(list)
    for v in votes:
        by_month[v['date'][:7]].append(v)
    keep = {'board.json'}
    months = []
    for month, vs in sorted(by_month.items()):
        vs.sort(key=lambda v: (v['date'], v['id']), reverse=True)
        rows = []
        used = set()
        for v in vs:
            pos = dict(v['positions'])
            rows.append([v['id'], v['date'], v['meeting_id'], v['agenda_number'], v['question'], v['bill_id'], v['result'], v['passed'],
                         v['tally']['yes'], v['tally']['no'], v['tally']['not_voting'], ''.join(pos.get(mid, '-') for mid in order),
                         v['mover'], v['seconder'], v['source_updated_at']])
            if v['bill_id']:
                used.add(v['bill_id'])
        name = 'votes-%s.json' % month
        keep.add(name)
        months.append({'file': name, 'month': month, 'votes': len(vs), 'recorded': sum(1 for v in vs if v['recorded'])})
        writer.write_json('us-ca/counties/%s/%s' % (fips, name), {
            'columns': VOTE_COLUMNS, 'members': order, 'codes': CODE_LABELS, 'rows': rows,
            'matters': {m['id']: m for m in matters.values() if m['id'] in used}})
    rec['members'] = members
    rec['meetings'] = meetings
    rec['vote_months'] = months
    rec['counts'] = {'meetings': len(meetings), 'votes': len(votes), 'matters': len(matters)}
    writer.write_json('us-ca/counties/%s/board.json' % fips, rec)
    if not LIMIT:
        writer.remove_stale('us-ca/counties/%s' % fips, keep)
    by_id = {m['id']: m for m in matters.values()}
    return [[v['id'], v['date'], rec['body'], rec['county'], v['question'], (by_id.get(v['bill_id']) or {}).get('label'),
             ((by_id.get(v['bill_id']) or {}).get('title') or '')[:160], v['result'], v['passed'],
             v['tally']['yes'], v['tally']['no'], v['tally']['not_voting'], v['recorded']] for v in votes]


LATEST_COLUMNS = ['id', 'date', 'body', 'county', 'question', 'matter_label', 'matter_title', 'result', 'passed', 'yes', 'no', 'other', 'recorded']


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
                manifest.ok(sid, source_updated_at=max((m['source_updated_at'] for m in meetings if m.get('source_updated_at')), default=None),
                            note='%d meetings, %d votes' % (len(meetings), len(votes)))
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
