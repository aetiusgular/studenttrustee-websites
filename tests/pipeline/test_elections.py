"""The Elections records against slices of the Google Civic elections list and the FEC candidates
API (Texas, two pages) in fixtures/elections/."""
import json
import os
import shutil
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'elections')


def read(name):
    with open(os.path.join(FIX, name), encoding='utf-8') as fh:
        return fh.read()


class FakeHttp:
    sites_down = ()

    def __init__(self, *a, **k):
        self.stale_served = []
        self.calls = 0
        self.urls = []

    def get(self, url, ttl=0, headers=None, params=None):
        from tools.legislation.common import FetchError
        from tools.legislation import elections
        self.calls += 1
        if params:
            from urllib.parse import urlencode
            url = url + ('&' if '?' in url else '?') + urlencode(params)
        self.urls.append(url)
        q = parse_qs(urlparse(url).query)
        if url.startswith(elections.CIVIC_URL):
            return read('civic-elections.json').encode(), {'fetched_at': 'x'}
        if url.startswith(elections.FEC_URL):
            if q.get('state') != ['TX']:
                return json.dumps({'results': [], 'pagination': {'pages': 1, 'page': 1}}).encode(), {}
            return read('fec-tx-page%s.json' % q['page'][0]).encode(), {}
        if any(url.startswith(d) for d in self.sites_down):
            raise FetchError('HTTP 503')
        return b'<html>ok</html>', {}

    def get_text(self, url, ttl=0, **kw):
        b, m = self.get(url, ttl=ttl, **kw)
        return b.decode(), m

    def get_json(self, url, ttl=0, **kw):
        b, m = self.get(url, ttl=ttl, **kw)
        return json.loads(b.decode()), m


def load(tmp, rel):
    with open(os.path.join(tmp, rel), encoding='utf-8') as fh:
        return json.load(fh)


class Elections(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer, elections
        self.tmp = tempfile.mkdtemp()
        self.saved = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH, elections.Http)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        elections.Http = FakeHttp
        os.environ['LEGIS_TODAY'] = '2026-10-10'
        os.environ['LEGIS_STATES'] = 'TX,CA'
        os.environ['LEGIS_NO_LINKCHECK'] = '1'
        os.environ['FEC_API_KEY'] = 'test'
        os.environ['GOOGLE_CIVIC_API_KEY'] = 'test'
        os.environ.pop('ALLOW_SHRINK', None)

    def tearDown(self):
        from tools.legislation import common, writer, elections
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH, elections.Http = self.saved
        for k in ('LEGIS_TODAY', 'LEGIS_STATES', 'LEGIS_NO_LINKCHECK', 'FEC_API_KEY', 'GOOGLE_CIVIC_API_KEY', 'ALLOW_SHRINK'):
            os.environ.pop(k, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_main(self):
        from tools.legislation import elections
        elections.main([])

    def test_calendar_keeps_real_elections_sorted_with_official_links(self):
        self.run_main()
        cal = load(self.tmp, 'elections/calendar.json')
        self.assertEqual(cal['cycle'], 2026)
        dates = [r['date'] for r in cal['elections']]
        self.assertEqual(dates, sorted(dates))
        la = [r for r in cal['elections'] if r['state'] == 'LA'][0]
        self.assertEqual(la['date'], '2026-10-24')
        self.assertTrue(la['official_url'].startswith('https://www.sos.la.gov'))
        self.assertIn('US', [r['state'] for r in cal['elections']])
        self.assertIn('g2000', [r['id'] for r in cal['elections']])  # Google's test election stays; the page filters by date

    def test_federal_races_group_candidates_and_follow_every_page(self):
        self.run_main()
        tx = load(self.tmp, 'elections/us-tx/federal.json')
        ids = {r['id']: r for r in tx['races']}
        self.assertEqual(set(ids), {'2026-tx-senate', '2026-tx-house-12'})   # the 2028 presidential filer is left out
        senate = ids['2026-tx-senate']
        self.assertEqual([c['name'] for c in senate['candidates']], ['CORNYN, JOHN', 'ALLRED, COLIN'])
        self.assertTrue(senate['candidates'][0]['incumbent'])
        house = ids['2026-tx-house-12']
        self.assertEqual(house['label'], 'Texas: U.S. House, district 12')
        self.assertEqual([c['party'] for c in house['candidates']], ['R', 'D'])
        self.assertEqual(tx['source_updated_at'], '2026-09-30')
        idx = load(self.tmp, 'elections/us/federal-index.json')
        self.assertEqual(len(idx['rows']), 2)
        man = load(self.tmp, 'manifest.json')
        self.assertEqual(man['sources']['fec-candidates']['status'], 'ok')
        self.assertEqual(man['counts']['el_federal_candidates'], 4)
        self.assertEqual(man['count_scopes']['el_federal_candidates'], '2026')

    def test_states_table_carries_deadlines_and_next_election(self):
        self.run_main()
        states = {s['code']: s for s in load(self.tmp, 'elections/states.json')['states']}
        self.assertEqual(len(states), 52)
        ca = states['CA']
        self.assertEqual(ca['deadlines']['registration'], '2026-10-19')
        self.assertEqual(ca['next_election'], {'name': 'California General Election', 'date': '2026-11-03'})
        self.assertEqual(ca['federal_races'], 0)
        self.assertEqual(states['TX']['federal_candidates'], 4)
        self.assertEqual(states['LA']['next_election']['date'], '2026-10-24')
        self.assertEqual(states['WY']['next_election']['date'], '2026-11-03')  # the national row

    def test_without_keys_the_sources_say_not_configured_and_the_general_election_stays(self):
        os.environ.pop('FEC_API_KEY')
        os.environ.pop('GOOGLE_CIVIC_API_KEY')
        self.run_main()
        man = load(self.tmp, 'manifest.json')
        self.assertEqual(man['sources']['fec-candidates']['status'], 'not_configured')
        self.assertEqual(man['sources']['google-civic-elections']['status'], 'not_configured')
        cal = load(self.tmp, 'elections/calendar.json')
        self.assertEqual([r['date'] for r in cal['elections']], ['2026-11-03'])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'elections/us-tx/federal.json')))

    def test_a_shrunken_feed_keeps_the_previous_file(self):
        from tools.legislation import elections, writer
        self.run_main()
        big = load(self.tmp, 'elections/us-tx/federal.json')
        big['races'][0]['candidates'] = [dict(big['races'][0]['candidates'][0], id='X%03d' % i, name='N%d' % i) for i in range(40)]
        writer.write_json('elections/us-tx/federal.json', big)
        elections.main([])
        kept = load(self.tmp, 'elections/us-tx/federal.json')
        self.assertEqual(len(kept['races'][0]['candidates']), 40)
        man = load(self.tmp, 'manifest.json')
        self.assertEqual(man['sources']['fec-candidates']['status'], 'partial')
        self.assertIn('kept the previous file', man['sources']['fec-candidates']['error'])
        os.environ['ALLOW_SHRINK'] = '1'
        elections.main([])
        self.assertEqual(len(load(self.tmp, 'elections/us-tx/federal.json')['races'][0]['candidates']), 2)

    def test_dead_state_sites_are_marked_partial(self):
        from tools.legislation import elections
        os.environ.pop('LEGIS_NO_LINKCHECK')
        FakeHttp.sites_down = ('https://www.sos.ca.gov', 'https://www.sos.state.tx.us', 'https://sos.wyo.gov')
        try:
            self.run_main()
        finally:
            FakeHttp.sites_down = ()
        states = {s['code']: s for s in load(self.tmp, 'elections/states.json')['states']}
        checked = [s for s in states.values() if s['site_checked_at']]
        self.assertTrue(7 <= len(checked) <= 8)
        down = [s['code'] for s in checked if not s['site_reachable']]
        man = load(self.tmp, 'manifest.json')
        if down:
            self.assertEqual(man['sources']['election-sites']['status'], 'partial')
            for st in down:
                self.assertIn(st, man['sources']['election-sites']['error'])
        else:
            self.assertEqual(man['sources']['election-sites']['status'], 'ok')
        self.assertTrue(all(s['site_reachable'] for s in states.values() if not s['site_checked_at']))
        self.assertIs(elections.Http, FakeHttp)

    def test_validator_accepts_the_output(self):
        from tools.legislation import legislation_checks
        self.run_main()
        self.assertEqual(legislation_checks.election_checks(), [])


class Helpers(unittest.TestCase):
    def test_state_of_ocd_division(self):
        from tools.legislation.elections import state_of
        self.assertEqual(state_of('ocd-division/country:us/state:ca'), 'CA')
        self.assertEqual(state_of('ocd-division/country:us'), 'US')
        self.assertEqual(state_of('ocd-division/country:us/district:dc'), 'DC')
        self.assertIsNone(state_of('ocd-division/country:ca'))

    def test_cycle(self):
        from datetime import date
        from tools.legislation.elections import cycle_for
        self.assertEqual(cycle_for(date(2026, 10, 10)), 2026)
        self.assertEqual(cycle_for(date(2027, 1, 5)), 2028)

    def test_race_ids_and_labels(self):
        from tools.legislation.elections import race_id, race_label
        self.assertEqual(race_id(2026, 'WY', 'H', '00'), '2026-wy-house-00')
        self.assertEqual(race_label('WY', 'H', '00'), 'Wyoming: U.S. House, at large')
        self.assertEqual(race_label('TX', 'S', '00'), 'Texas: U.S. Senate')


if __name__ == '__main__':
    unittest.main()
