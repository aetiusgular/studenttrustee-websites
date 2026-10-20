"""
The Elections section's records: upcoming elections, each state's deadlines and election office,
and the candidates in every federal race.

Sources
  Google Civic Information API, electionQuery (free key in GOOGLE_CIVIC_API_KEY): the elections
    Google has ballot data for, with the date and the state. Not official; each row links the
    state's own election office. Without the key the calendar keeps the general election date
    from election-sites.json and says so.
  election-sites.json (hand-maintained, next to this file): every state's election office and
    site, and the cycle's deadlines where entered. The links are checked once a week, a seventh of
    them each night, like the county board links.
  FEC API, /candidates/ (free api.data.gov key in FEC_API_KEY): every House, Senate and
    presidential candidate registered for the cycle, by state and district, with party, whether
    they are the incumbent, and whether they have raised money. Official. Registering with the FEC
    is not the same as qualifying for the ballot; the page says so and links the state's list.
    Without the key the races stay as they were and the source is "not configured".

Output (inside data/legislation/, which GitHub Pages publishes):
  elections/calendar.json          every known election, soonest first
  elections/states.json            one row per state: office, site, deadlines, next election,
                                   federal race and candidate counts
  elections/us-{st}/federal.json   that state's federal races and candidates
  elections/us/federal-index.json  every race in one table for the national list

Certified ballots (election-ballots/{st}-{cycle}.json, hand-entered from the state's certified list of
candidates and the county registrars' lists) are laid over the FEC records every night: a ballot race
replaces the FEC race with the same id, and its state and county races are added with `level` set.
Without this the FEC rewrite would drop them. The federal index and counts cover federal races only.

A state whose federal candidate file loses more than a fifth of its candidates overnight keeps the
previous file unless ALLOW_SHRINK=1 (the FEC API paging once returned an empty page).
"""
import json
import os
from . import districts, writer
from .common import Http, Manifest, now_iso, today

CIVIC_URL = 'https://www.googleapis.com/civicinfo/v2/elections'
CIVIC_KEY_ENV = 'GOOGLE_CIVIC_API_KEY'
FEC_URL = 'https://api.open.fec.gov/v1/candidates/'
FEC_KEY_ENV = 'FEC_API_KEY'
FEC_PER_PAGE = 100
SITES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'election-sites.json')
BALLOTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'election-ballots')
SCHEMA = 1
SHRINK = 0.8
SID_CIVIC = 'google-civic-elections'
SID_SITES = 'election-sites'
SID_FEC = 'fec-candidates'
OFFICE_NAME = {'H': 'U.S. House', 'S': 'U.S. Senate', 'P': 'President'}
PARTY = {'DEM': 'D', 'REP': 'R', 'IND': 'I', 'LIB': 'L', 'GRE': 'G', 'NPA': 'NP', 'NON': 'NP', 'NNE': 'NP',
         'DFL': 'D', 'CON': 'C', 'W': 'W', 'UNK': ''}


def load_sites():
    with open(SITES_PATH, encoding='utf-8') as fh:
        return json.load(fh)


def cycle_for(day):
    """Federal election cycles are even years; an odd year belongs to the next one."""
    return day.year if day.year % 2 == 0 else day.year + 1


def state_of(ocd):
    """'ocd-division/country:us/state:ca' -> 'CA'; the country alone -> 'US'."""
    for part in (ocd or '').split('/'):
        if part.startswith('state:'):
            return part[6:].upper()
        if part.startswith('district:dc'):
            return 'DC'
        if part.startswith('territory:pr'):
            return 'PR'
    return 'US' if (ocd or '').endswith('country:us') else None


def civic_elections(http, key, sites):
    """The calendar rows. Without a key, the general election date from election-sites.json."""
    if not key:
        return None, None
    data, meta = http.get_json(CIVIC_URL, params={'key': key})
    rows = []
    for e in data.get('elections') or []:
        st = state_of(e.get('ocdDivisionId'))
        day = (e.get('electionDay') or '')[:10]
        if not day or st is None:
            continue
        rows.append({'id': 'g%s' % e.get('id'), 'name': e.get('name') or 'Election', 'date': day, 'state': st,
                     'official_url': sites['states'].get(st, {}).get('site') if st != 'US' else None,
                     'source': {'id': SID_CIVIC}})
    rows.sort(key=lambda r: (r['date'], r['state'], r['name']))
    return rows, meta


def fallback_calendar(sites):
    day = sites.get('general_election')
    if not day:
        return []
    return [{'id': 'general-%s' % day, 'name': 'General election', 'date': day, 'state': 'US', 'official_url': None,
             'source': {'id': SID_SITES}}]


def check_sites(http, sites, nightly_share=7):
    """A seventh of the state sites each night. Returns {st: reachable} for the ones checked."""
    if os.environ.get('LEGIS_NO_LINKCHECK'):
        return {}
    codes = sorted(sites['states'])
    slot = today().toordinal() % nightly_share
    out = {}
    for i, st in enumerate(codes):
        if i % nightly_share != slot:
            continue
        url = sites['states'][st].get('site')
        if not url:
            continue
        try:
            http.get(url, ttl=0)
            out[st] = True
        except Exception:
            out[st] = False
    return out


def fec_party(code):
    c = (code or '').upper()
    return PARTY.get(c, c[:3])


def race_id(cycle, st, office, district):
    if office == 'S':
        return '%d-%s-senate' % (cycle, st.lower())
    if office == 'P':
        return '%d-president' % cycle
    return '%d-%s-house-%s' % (cycle, st.lower(), district or '00')


def race_label(st, office, district):
    name = districts.STATES.get(st, (st,))[0]
    if office == 'S':
        return '%s: U.S. Senate' % name
    if office == 'P':
        return 'President of the United States'
    d = (district or '').lstrip('0')
    return '%s: U.S. House, district %s' % (name, d) if d else '%s: U.S. House, at large' % name


def fec_candidates(http, key, cycle, st):
    """Every candidate the FEC lists for this state and cycle, all pages."""
    rows = []
    page = 1
    newest = None
    while True:
        params = {'api_key': key, 'state': st, 'election_year': cycle, 'per_page': FEC_PER_PAGE, 'page': page,
                  'sort': 'name', 'candidate_status': 'C'}
        data, meta = http.get_json(FEC_URL, params=params)
        for c in data.get('results') or []:
            office = (c.get('office') or '')[:1].upper()
            if office not in OFFICE_NAME:
                continue
            years = c.get('election_years') or []
            if years and cycle not in years:
                continue
            rows.append({'id': c.get('candidate_id'), 'name': c.get('name') or '', 'party': fec_party(c.get('party')),
                         'party_full': c.get('party_full') or '', 'office': office, 'district': (c.get('district') or '00')[-2:],
                         'incumbent': (c.get('incumbent_challenge') or '') == 'I',
                         'raised': bool(c.get('has_raised_funds')), 'first_filed': c.get('first_file_date'),
                         'last_filed': c.get('last_file_date'),
                         'fec_url': 'https://www.fec.gov/data/candidate/%s/' % c.get('candidate_id')})
        lf = max((c.get('last_file_date') or '' for c in data.get('results') or []), default='')
        if lf and (newest is None or lf > newest):
            newest = lf
        pages = (data.get('pagination') or {}).get('pages') or 1
        if page >= pages or not data.get('results'):
            break
        page += 1
    return rows, newest


def group_races(cycle, st, candidates):
    races = {}
    for c in candidates:
        rid = race_id(cycle, st, c['office'], c['district'])
        r = races.setdefault(rid, {'id': rid, 'state': st, 'office': c['office'], 'office_name': OFFICE_NAME[c['office']],
                                   'district': c['district'] if c['office'] == 'H' else None,
                                   'label': race_label(st, c['office'], c['district']), 'candidates': []})
        r['candidates'].append(c)
    out = []
    for r in races.values():
        r['candidates'].sort(key=lambda c: (not c['incumbent'], not c['raised'], c['name']))
        out.append(r)
    out.sort(key=lambda r: ({'P': 0, 'S': 1, 'H': 2}[r['office']], r['district'] or ''))
    return out


def is_federal(race):
    return (race.get('level') or 'federal') == 'federal'


def federal_counts(races):
    fed = [r for r in races or [] if is_federal(r)]
    return len(fed), sum(len(r['candidates']) for r in fed)


def load_ballot(st, cycle):
    path = os.path.join(BALLOTS_DIR, '%s-%d.json' % (st.lower(), cycle))
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def merge_ballot(st, cycle):
    """Lay the state's certified ballot over its federal.json. Returns the number of ballot races, or 0."""
    ballot = load_ballot(st, cycle)
    if not ballot or not ballot.get('races'):
        return 0
    rel = 'elections/us-%s/federal.json' % st.lower()
    f = writer.read_json(rel, {}) or {'schema_version': SCHEMA, 'state': st, 'cycle': cycle, 'races': []}
    mine = {r['id'] for r in ballot['races']}
    races = [r for r in f.get('races') or [] if r['id'] not in mine and is_federal(r)]
    fec_by_id = {r['id']: r for r in f.get('races') or [] if is_federal(r)}
    for r in ballot['races']:
        r = dict(r)
        if is_federal(r) and r['id'] in fec_by_id:
            # keep the FEC's filing dates and links for the people on the certified list
            fec = {c['id']: c for c in fec_by_id[r['id']]['candidates']}
            r['candidates'] = [dict(fec.get(c['id'], {}), **{k: v for k, v in c.items() if v is not None}) for c in r['candidates']]
        races.append(r)
    order = {'federal': 0, 'state': 1, 'county': 2}
    races.sort(key=lambda r: (order.get(r.get('level') or 'federal', 3), {'P': 0, 'S': 1, 'H': 2}.get(r.get('office'), 3), r.get('district') or '', r['id']))
    f['races'] = races
    f['ballot'] = {k: ballot.get(k) for k in ('certified_at', 'official_list_url', 'source', 'level_notes')}
    writer.write_json(rel, f)
    return len(ballot['races'])


def next_election(rows, st, day):
    for r in rows:
        if r['date'] >= day.isoformat() and r['state'] in (st, 'US'):
            return {'name': r['name'], 'date': r['date']}
    return None


def main(argv=None):
    http = Http()
    manifest = Manifest()
    sites = load_sites()
    day = today()
    cycle = cycle_for(day)
    allow_shrink = bool(os.environ.get('ALLOW_SHRINK'))
    retrieved = now_iso()
    wanted = os.environ.get('LEGIS_STATES')
    codes = [s for s in sorted(districts.STATES) if not wanted or s in wanted.upper().split(',')]

    # 1. Calendar
    manifest.describe(SID_CIVIC, 'Google Civic Information API: upcoming elections',
                      'https://developers.google.com/civic-information', 'election', official=False)
    civic_key = os.environ.get(CIVIC_KEY_ENV, '').strip()
    rows = None
    if not civic_key:
        manifest.source(SID_CIVIC).update({'status': 'not_configured', 'last_checked_at': now_iso(),
                                           'note': 'Needs a Google Civic Information API key in the %s secret' % CIVIC_KEY_ENV})
        print('   calendar: %s is not set; using the general election date only' % CIVIC_KEY_ENV)
    else:
        try:
            rows, meta = civic_elections(http, civic_key, sites)
            if meta.get('stale'):
                manifest.partial(SID_CIVIC, meta.get('error') or 'stale copy served')
            else:
                manifest.ok(SID_CIVIC)
        except Exception as e:
            manifest.error(SID_CIVIC, e)
            print('   calendar: %s' % e)
    old_cal = writer.read_json('elections/calendar.json', {}) or {}
    if rows is None:
        rows = [r for r in (old_cal.get('elections') or []) if r['date'] >= day.isoformat()] or fallback_calendar(sites)
    writer.write_json('elections/calendar.json', {'schema_version': SCHEMA, 'cycle': cycle, 'as_of': day.isoformat(),
                                                   'elections': rows, 'retrieved_at': retrieved})
    manifest.count('el_elections', len(rows), scope=cycle)

    # 2. State sites and deadlines
    manifest.describe(SID_SITES, 'State election offices and deadlines (hand-checked)',
                      'https://github.com/aetiusgular/studenttrustee-websites/blob/main/tools/legislation/election-sites.json',
                      'election', official=False)
    old_states = {r['code']: r for r in ((writer.read_json('elections/states.json', {}) or {}).get('states') or [])}
    checked = check_sites(http, sites)
    dead = sorted(st for st, ok in checked.items() if not ok)
    if dead:
        manifest.partial(SID_SITES, 'not answering: ' + ', '.join(dead), note='checked %s' % sites.get('checked'))
    else:
        manifest.ok(SID_SITES, note='checked %s' % sites.get('checked'))

    # 3. Federal candidates
    manifest.describe(SID_FEC, 'Federal Election Commission: registered candidates', 'https://api.open.fec.gov/developers/',
                      'election', official=True, license='Public domain')
    fec_key = os.environ.get(FEC_KEY_ENV, '').strip()
    fec_counts = {}
    failed, ok_states, newest = [], [], None
    if not fec_key:
        manifest.source(SID_FEC).update({'status': 'not_configured', 'last_checked_at': now_iso(),
                                         'note': 'Needs a free api.data.gov key in the %s secret' % FEC_KEY_ENV})
        print('   federal candidates: %s is not set' % FEC_KEY_ENV)
        for st in codes:
            old = writer.read_json('elections/us-%s/federal.json' % st.lower(), {}) or {}
            fec_counts[st] = federal_counts(old.get('races'))
    else:
        for st in codes:
            rel = 'elections/us-%s/federal.json' % st.lower()
            old = writer.read_json(rel, {}) or {}
            prev_n = federal_counts(old.get('races'))[1] if old.get('cycle') == cycle else 0
            try:
                cands, lf = fec_candidates(http, fec_key, cycle, st)
            except Exception as e:
                failed.append('%s: %s' % (st, str(e)[:80]))
                fec_counts[st] = (federal_counts(old.get('races'))[0], prev_n)
                continue
            if prev_n > 20 and len(cands) < prev_n * SHRINK and not allow_shrink:
                failed.append('%s: %d candidates, had %d; kept the previous file' % (st, len(cands), prev_n))
                fec_counts[st] = (federal_counts(old.get('races'))[0], prev_n)
                continue
            races = group_races(cycle, st, cands)
            writer.write_json(rel, {'schema_version': SCHEMA, 'state': st, 'cycle': cycle, 'races': races,
                                    'source_updated_at': lf, 'retrieved_at': retrieved,
                                    'official_list_url': sites['states'].get(st, {}).get('site')})
            fec_counts[st] = (len(races), len(cands))
            ok_states.append(st)
            if lf and (newest is None or lf > newest):
                newest = lf
        if failed and ok_states:
            manifest.partial(SID_FEC, 'failed: ' + '; '.join(failed)[:400], source_updated_at=newest)
        elif failed:
            manifest.error(SID_FEC, 'failed: ' + '; '.join(failed)[:400])
        else:
            manifest.ok(SID_FEC, source_updated_at=newest)
    if http.stale_served:
        print('   served from cache after errors: %d' % len(http.stale_served))

    # 3b. Certified ballots over the FEC records
    for st in codes:
        n = merge_ballot(st, cycle)
        if n:
            print('   %s: %d races from the certified ballot' % (st, n))
            if st in fec_counts:
                f = writer.read_json('elections/us-%s/federal.json' % st.lower(), {}) or {}
                fec_counts[st] = federal_counts(f.get('races'))

    # 4. The national race index and the states table
    index_rows = []
    for st in codes:
        f = writer.read_json('elections/us-%s/federal.json' % st.lower(), {}) or {}
        for r in f.get('races') or []:
            if not is_federal(r):
                continue
            inc = [c['name'] for c in r['candidates'] if c['incumbent']]
            index_rows.append([r['id'], st, r['office'], r['district'], r['label'], len(r['candidates']), inc[0] if inc else None])
    writer.write_json('elections/us/federal-index.json', {'schema_version': SCHEMA, 'cycle': cycle,
                                                           'columns': ['id', 'state', 'office', 'district', 'label', 'candidates', 'incumbent'],
                                                           'rows': index_rows, 'retrieved_at': retrieved})
    states_rows = []
    for st in sorted(districts.STATES):
        s = sites['states'].get(st, {})
        prev = old_states.get(st, {})
        reachable = checked.get(st, prev.get('site_reachable', True))
        n_races, n_cands = fec_counts.get(st, (prev.get('federal_races', 0), prev.get('federal_candidates', 0)))
        states_rows.append({'code': st, 'name': districts.STATES[st][0], 'office': s.get('office'), 'site': s.get('site'),
                            'site_reachable': reachable, 'site_checked_at': now_iso() if st in checked else prev.get('site_checked_at'),
                            'deadlines': {k: s.get(k) for k in ('registration', 'registration_note', 'mail_request', 'mail_request_note',
                                                                'mail_return', 'mail_return_note', 'postmark', 'early_start', 'early_end')},
                            'next_election': next_election(rows, st, day),
                            'federal_races': n_races, 'federal_candidates': n_cands})
    writer.write_json('elections/states.json', {'schema_version': SCHEMA, 'cycle': cycle, 'general_election': sites.get('general_election'),
                                                 'deadlines_checked': sites.get('checked'), 'states': states_rows, 'retrieved_at': retrieved})
    manifest.count('el_federal_candidates', sum(c for _, c in fec_counts.values()), scope=cycle)
    manifest.count('el_federal_races', sum(r for r, _ in fec_counts.values()), scope=cycle)
    manifest.save()
    print('   elections: %d on the calendar, %d federal races, %d candidates, %d state sites checked' % (
        len(rows), sum(r for r, _ in fec_counts.values()), sum(c for _, c in fec_counts.values()), len(checked)))


if __name__ == '__main__':
    main()
