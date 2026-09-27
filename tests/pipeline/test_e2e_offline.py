"""End-to-end run of the federal and geo targets against fixtures, writing to a temp dir."""
import json
import os
import shutil
import tempfile
import unittest

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
URLS = {
    'https://clerk.house.gov/evs/2026/index.asp': 'house-evs-index-2026.html',
    'https://clerk.house.gov/evs/2026/roll314.xml': 'house-roll314.xml',
    'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml': 'senate-vote-menu-119-2.xml',
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml': 'senate-vote-119-2-244.xml',
    'https://docs.house.gov/floor/': 'house-floor-page.html',
    'https://docs.house.gov/floor/Download.aspx?file=/billsthisweek/20260914/20260914.xml': 'house-billsthisweek-20260914.xml',
    'https://www.senate.gov/general/committee_schedules/hearings.xml': 'senate-hearings.xml',
    'https://www.senate.gov/legislative/schedule/floor_schedule.xml': 'senate-floor-schedule.xml',
    'https://unitedstates.github.io/congress-legislators/legislators-current.json': 'legislators-current-sample.json',
    'https://www2.census.gov/geo/docs/reference/codes2020/cou/st06_ca_cou2020.txt': 'census-ca-counties.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_cd11920_county20_st06.txt': 'census-cd119-county-ca.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_sldu202420_county20_st06.txt': 'census-sldu2024-county-ca.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_sldl202420_county20_st06.txt': 'census-sldl2024-county-ca.txt',
    'https://selc.senate.ca.gov/media/604': 'ab604-head.csv',
}


class FakeHttp:
    calls = 0

    def get(self, url, ttl=0, headers=None, params=None):
        from tools.legislation.common import FetchError
        if params:
            from urllib.parse import urlencode
            url = url + ('&' if '?' in url else '?') + urlencode(params)
        name = URLS.get(url)
        if not name:
            raise FetchError('HTTP 404 for %s (not in fixtures)' % url)
        with open(os.path.join(FIX, name), 'rb') as fh:
            return fh.read(), {'last_modified': 'Thu, 24 Sep 2026 20:00:00 GMT', 'fetched_at': '2026-09-26T05:31:00Z', 'from_cache': False}

    def get_text(self, url, ttl=0, encoding='utf-8', **kw):
        b, m = self.get(url, ttl, **kw)
        return b.decode(encoding, 'replace'), m

    def get_json(self, url, ttl=0, **kw):
        b, m = self.get(url, ttl, **kw)
        return json.loads(b.decode('utf-8')), m


def load(*parts):
    with open(os.path.join(*parts), encoding='utf-8') as fh:
        return json.load(fh)


class EndToEnd(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        common.Http = FakeHttp
        os.environ['LEGIS_YEARS'] = '2026'
        os.environ['LEGIS_LIMIT'] = '1'
        os.environ.pop('CONGRESS_API_KEY', None)

    def tearDown(self):
        from tools.legislation import common, writer
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('LEGIS_YEARS', None); os.environ.pop('LEGIS_LIMIT', None)

    def test_federal_and_geo(self):
        import importlib
        from tools.legislation import federal, geo
        importlib.reload(federal)
        federal.Http = FakeHttp
        geo.Http = FakeHttp
        federal.main([])
        geo.main([])
        m = load(self.tmp, 'manifest.json')
        self.assertEqual(m['sources']['us-house-clerk']['status'], 'ok')
        self.assertEqual(m['sources']['us-senate-lis']['status'], 'ok')
        self.assertEqual(m['sources']['docs-house-floor']['status'], 'ok')
        self.assertEqual(m['sources']['congress-gov-api']['status'], 'not_configured')
        self.assertEqual(m['counts']['us_votes'], 2)
        self.assertEqual(m['counts']['ca_counties'], 58)
        idx = load(self.tmp, 'us/votes/119-2-house.json')
        self.assertEqual(idx['rows'][0][0], 'us-house-119-2-314')
        vote = load(self.tmp, 'us/votes/us-house-119-2-314.json')
        self.assertEqual(len(vote['positions']), 433)
        rec = load(self.tmp, 'us/records/house-119.json')
        self.assertEqual(rec['votes'], ['us-house-119-2-314'])
        self.assertEqual(rec['members']['A000370'], 'Y')
        bills = load(self.tmp, 'us/bills/119/index.json')
        self.assertTrue(any(r[0] == 'us-119-s-2403' for r in bills['rows']))
        up = load(self.tmp, 'us/upcoming.json')
        self.assertTrue(any(i['kind'] == 'floor' and i['body'] == 'us-house' for i in up['items']))
        counties = load(self.tmp, 'geo/us-ca/counties.json')
        cc = next(c for c in counties['counties'] if c['fips'] == '06013')
        self.assertTrue(cc['us_house']['current'] and cc['ca_senate'] and cc['ca_assembly'])
        states = load(self.tmp, 'geo/states.json')
        self.assertEqual(len(states['states']), 56)


if __name__ == '__main__':
    unittest.main()
