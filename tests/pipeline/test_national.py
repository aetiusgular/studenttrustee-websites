"""National geography, county boards and every state's legislators, against slices of the real
Census, Wikidata and Open States files in fixtures/national/ (Texas, New Hampshire, Idaho, Vermont,
Nebraska, DC, Maine, Alaska, Connecticut, Puerto Rico)."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import date

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'national')


def read(name):
    with open(os.path.join(FIX, name), encoding='utf-8-sig') as fh:
        return fh.read()


class FakeHttp:
    def __init__(self, *a, **k):
        self.stale_served = []
        self.calls = 0
        self.cache_dir = tempfile.mkdtemp()

    def get(self, url, ttl=0, headers=None, params=None):
        from tools.legislation.common import FetchError
        from tools.legislation import boards
        self.calls += 1
        name = url.split('/')[-1]
        if url.startswith(boards.WIKIDATA):
            return read('wikidata-counties.json').encode(), {}
        if '/people/current/' in url:
            p = os.path.join(FIX, 'people-' + name)
            if not os.path.exists(p):
                raise FetchError('HTTP 404 for ' + url)
            return read('people-' + name).encode(), {'last_modified': 'Thu, 24 Sep 2026 16:37:32 GMT'}
        if os.path.exists(os.path.join(FIX, name)):
            return read(name).encode(), {}
        raise FetchError('HTTP 404 for ' + url)

    def get_text(self, url, ttl=0, encoding='utf-8', **kw):
        b, m = self.get(url, ttl, **kw)
        return b.decode(encoding), m

    def get_json(self, url, ttl=0, **kw):
        b, m = self.get(url, ttl, **kw)
        return json.loads(b.decode('utf-8')), m


class Keys(unittest.TestCase):
    def test_keys_join_census_and_open_states(self):
        from tools.legislation.districts import key
        pairs = [('014', '14'), ('01A', '1A'), ('00A', 'A'), ('State House District Belknap 01', 'Belknap 1'),
                 ('1st Barnstable District', '1st Barnstable'), ('Addison-1 State House District', 'Addison-1'),
                 ('Berkshire-Hampden-Franklin-Hampshire District', 'Berkshire, Hampden, Franklin and Hampshire'), ('Ward 1', 'Ward 1')]
        for census, os_value in pairs:
            self.assertEqual(key(census), key(os_value), (census, os_value))

    def test_labels(self):
        from tools.legislation.districts import label
        self.assertEqual(label('014', 'State Senate District 14'), '14')
        self.assertEqual(label('001', 'State House District Belknap 01'), 'Belknap 1')
        self.assertEqual(label('A-1', 'Addison-1 State House District'), 'Addison-1')
        self.assertEqual(label('00A', 'State Senate District A'), 'A')
        self.assertEqual(label('001', 'Ward 1'), 'Ward 1')


class Boards(unittest.TestCase):
    def test_names(self):
        from tools.legislation.boards import board_name
        self.assertEqual(board_name('TX', '48453', 'Travis County'), ('Commissioners Court', None))
        self.assertIsNone(board_name('CT', '09001', 'Fairfield County')[0])
        self.assertIsNone(board_name('AK', '02290', 'Yukon-Koyukuk Census Area')[0])
        self.assertEqual(board_name('AK', '02020', 'Anchorage Municipality')[0], 'Assembly')
        self.assertEqual(board_name('VA', '51760', 'Richmond city')[0], 'City Council')
        self.assertEqual(board_name('OR', '41051', 'Multnomah County')[0], 'County government')

    def test_pick_url(self):
        from tools.legislation.boards import pick_url
        self.assertEqual(pick_url({'http://www.co.x.tx.us/', 'https://www.co.x.tx.us/'}), 'https://www.co.x.tx.us/')
        self.assertEqual(pick_url({'https://example.com/county', 'https://x.gov/'}), 'https://x.gov/')
        self.assertIsNone(pick_url({'javascript:alert(1)'}))

    def test_link_check_rotation(self):
        from tools.legislation import boards
        os.environ.pop('LEGIS_NO_LINKCHECK', None)
        day = date(2026, 9, 28)
        rows = [{'fips': '%05d' % n, 'url': 'https://c%d.gov/' % n, 'checked_at': '2026-09-20T00:00:00Z'} for n in range(1, 15)]
        rows.append({'fips': '99999', 'url': 'https://new.gov/'})
        seen = []
        n = boards.check_links(rows, day, checker=lambda u: (seen.append(u) or ('dead' if 'c7' in u else 'ok', 200)))
        due = [r for r in rows if boards.due(r['fips'], day)]
        self.assertEqual(n, len(due) + 1)            # tonight's seventh plus the never-checked one
        self.assertIn('https://new.gov/', seen)
        self.assertTrue(all(r.get('status') for r in due))
        os.environ['LEGIS_NO_LINKCHECK'] = '1'

    def test_https_first(self):
        from tools.legislation import boards
        os.environ.pop('LEGIS_NO_LINKCHECK', None)
        rows = [{'fips': '48453', 'url': 'http://www.traviscountytx.gov', 'source_url': 'http://www.traviscountytx.gov'},
                {'fips': '48301', 'url': 'http://old.example.us', 'source_url': 'http://old.example.us'}]
        tried = []

        def checker(u):
            tried.append(u)
            return ('ok', 200) if u.startswith('https://www.travis') or u == 'http://old.example.us' else ('unreachable', None)
        boards.check_links(rows, date(2026, 9, 28), checker=checker)
        self.assertEqual(rows[0]['url'], 'https://www.traviscountytx.gov')
        self.assertEqual(rows[1]['url'], 'http://old.example.us')      # https did not answer; the working address stays
        self.assertEqual(rows[1]['status'], 'ok')
        self.assertEqual(tried[:1], ['https://www.traviscountytx.gov'])
        os.environ['LEGIS_NO_LINKCHECK'] = '1'


class National(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer, geo, states
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH, geo.Http, states.Http)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        geo.Http = states.Http = FakeHttp
        os.environ['LEGIS_NO_LINKCHECK'] = '1'

    def tearDown(self):
        from tools.legislation import common, writer, geo, states
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH, geo.Http, states.Http = self.old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def load(self, rel):
        with open(os.path.join(self.tmp, rel), encoding='utf-8') as fh:
            return json.load(fh)

    def run_all(self):
        from tools.legislation import geo, states
        geo.main([])
        states.main([])
        return self.load('manifest.json')

    def test_counties_everywhere(self):
        m = self.run_all()
        self.assertEqual(m['sources']['census-geo']['status'], 'error')   # the California file is not in the fixtures
        tx = self.load('geo/us-tx/counties.json')
        travis = [c for c in tx['counties'] if c['name'] == 'Travis County'][0]
        self.assertEqual(travis['slug'], 'travis')
        self.assertEqual(travis['cd'], [10, 17, 21, 35, 37])
        self.assertEqual(travis['sldu'], ['14', '21', '25'])
        self.assertIn('46', travis['sldl'])
        self.assertEqual(travis['board']['name'], 'Commissioners Court')
        self.assertTrue(travis['board']['url'].startswith('https://'))
        ct = self.load('geo/us-ct/counties.json')
        self.assertTrue(all(c['board']['none'] for c in ct['counties']))
        ak = {c['name']: c for c in self.load('geo/us-ak/counties.json')['counties']}
        self.assertIsNone(ak['Yukon-Koyukuk Census Area']['board']['name'])
        self.assertEqual(ak['Anchorage Municipality']['board']['name'], 'Assembly')
        pr = self.load('geo/us-pr/counties.json')
        self.assertEqual(pr['county_word'], 'municipio')
        self.assertEqual(self.load('geo/us-dc/counties.json')['counties'][0]['cd'], [0])   # the delegate seat
        index = self.load('geo/counties.json')
        self.assertIn(['48453', 'Travis County', 'TX', 'travis'], index['rows'])
        states_rows = {s['code']: s for s in self.load('geo/states.json')['states']}
        self.assertEqual(states_rows['TX']['coverage'], 'members')
        self.assertEqual(states_rows['CA']['coverage'], 'full')
        self.assertEqual(states_rows['GU']['coverage'], 'federal')
        self.assertEqual(states_rows['NE']['legislature']['chambers'][0]['id'], 'legislature')

    def test_legislators(self):
        m = self.run_all()
        src = m['sources']['openstates-people']
        self.assertEqual(src['status'], 'partial')                   # states without a fixture file fail
        self.assertEqual(src['source_updated_at'], '2026-09-24T16:37:32Z')
        tx = {x['district']: x for x in self.load('us-tx/members.json')['members'] if x['chamber'] == 'upper'}
        self.assertEqual(tx['14']['district_key'], '14')
        self.assertTrue(tx['14']['id'].startswith('tx-'))
        self.assertTrue(all((x['url'] or 'https://').startswith('https://') for x in tx.values()))
        idaho = self.load('us-id/members.json')['members']
        self.assertEqual({x['district_key'] for x in idaho}, {'1'})       # seats 1A and 1B sit in district 1
        vt = [x for x in self.load('us-vt/members.json')['members'] if x['district'] == 'Chittenden Southeast']
        self.assertTrue(vt and vt[0]['district_key'])
        nh = {x['district']: x for x in self.load('us-nh/members.json')['members']}
        self.assertEqual(nh['Belknap 8']['county_fips'], ['33001'])     # floterial district, matched by county
        dc = self.load('us-dc/members.json')['members']
        self.assertTrue(any(x['at_large'] for x in dc))
        ne = self.load('us-ne/members.json')['members']
        self.assertTrue(all(x['chamber'] == 'legislature' for x in ne))
        me = [x for x in self.load('us-me/members.json')['members'] if 'Maliseet' in x['district']]
        self.assertIsNone(me[0]['district_key'])
        s = self.load('us-tx/summary.json')
        self.assertEqual([c['seats'] for c in s['chambers']], [31, 150])
        self.assertEqual(s['source']['official'], False)
        search = self.load('search/states.json')
        self.assertTrue(any('Eckhardt' in r[2] and r[4] == 'us-tx-upper' for r in search['rows']))
        self.assertEqual({r[4].split('-')[1] for r in search['rows']}, {'tx', 'nh', 'id', 'vt', 'ne', 'dc', 'me'})
        self.assertEqual(s['chambers'][0]['official_site'], 'https://senate.texas.gov/')
        leg = self.load('legislatures.json')['states']
        self.assertEqual(leg['TX']['members'], len(self.load('us-tx/members.json')['members']))
        self.assertEqual(leg['TX']['seats'], 181)
        self.assertFalse(leg['TX']['official'])

    def test_validator_passes_and_catches(self):
        from tools.legislation import legislation_checks, writer
        self.run_all()
        self.assertEqual(legislation_checks.national_checks(), [])
        tx = self.load('geo/us-tx/counties.json')
        tx['counties'][0]['sldu'] = ['999']
        tx['counties'][1]['board'] = {'name': 'Commissioners Court', 'url': 'javascript:alert(1)'}
        writer.write_json('geo/us-tx/counties.json', tx)
        failures = legislation_checks.national_checks()
        self.assertTrue(any('999' in f for f in failures), failures)
        self.assertTrue(any('not http(s)' in f for f in failures), failures)

    def test_truncated_file_keeps_the_previous_one(self):
        from tools.legislation import states
        self.run_all()
        before = self.load('us-tx/members.json')['members']
        full = read('people-tx.csv')
        short = '\n'.join(full.splitlines()[:2]) + '\n'

        class Short(FakeHttp):
            def get(self, url, ttl=0, headers=None, params=None):
                if url.endswith('/tx.csv'):
                    return short.encode(), {}
                return FakeHttp.get(self, url, ttl, headers, params)
        states.Http = Short
        os.environ['LEGIS_STATES'] = 'TX'
        try:
            states.main([])
        finally:
            os.environ.pop('LEGIS_STATES', None)
        self.assertEqual(self.load('us-tx/members.json')['members'], before)
        m = self.load('manifest.json')
        self.assertIn('TX (1 legislators, %d last night' % len(before), m['sources']['openstates-people']['error'])
        self.assertEqual(self.load('legislatures.json')['states']['TX']['members'], len(before))


if __name__ == '__main__':
    unittest.main()
