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
    'https://unitedstates.github.io/congress-legislators/legislators-historical.json': 'legislators-historical-sample.json',
    'https://www2.census.gov/geo/docs/reference/codes2020/cou/st06_ca_cou2020.txt': 'census-ca-counties.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_cd11920_county20_st06.txt': 'census-cd119-county-ca.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_sldu202420_county20_st06.txt': 'census-sldu2024-county-ca.txt',
    'https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_sldl202420_county20_st06.txt': 'census-sldl2024-county-ca.txt',
    'https://selc.senate.ca.gov/media/604': 'ab604-head.csv',
    'https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml': 'cvc_member_data.xml',
    'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/s/BILLSTATUS-119s2403.xml': 'BILLSTATUS-119s2403.xml',
    'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hconres/BILLSTATUS-119hconres89.xml': 'BILLSTATUS-119hconres89.xml',
    'https://www.dailypress.senate.gov/wp-json/wp/v2/posts?per_page=3&_fields=id%2Cdate_gmt%2Cmodified_gmt%2Clink%2Ctitle%2Ccontent': 'dailypress-posts.json',
    'https://voteview.com/api/search?q=congress%3A119&chamber=Senate&startdate=2025-01-03': 'voteview-search-senate-119-20260922.json',
    'https://voteview.com/api/download?rollcall_id=RS1190903': 'voteview-download-RS1190903.json',
}


class FakeHttp:
    calls = 0
    blocked = ()          # URL prefixes that fail, as senate.gov does for some cloud servers

    def __init__(self, *a, **k):
        self.stale_served = []

    def get(self, url, ttl=0, headers=None, params=None):
        from tools.legislation.common import FetchError
        if params:
            from urllib.parse import urlencode
            url = url + ('&' if '?' in url else '?') + urlencode(params)
        name = URLS.get(url)
        if any(url.startswith(b) for b in self.blocked):
            raise FetchError('HTTP 403 for %s (blocked in this test)' % url)
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
        self.old_http = common.Http
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        common.Http = FakeHttp
        os.environ['LEGIS_YEARS'] = '2026'
        os.environ['LEGIS_LIMIT'] = '1'
        os.environ['LEGIS_TODAY'] = '2026-09-26'
        FakeHttp.blocked = ()

    def tearDown(self):
        from tools.legislation import common, writer
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        common.Http = self.old_http
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('LEGIS_YEARS', None); os.environ.pop('LEGIS_LIMIT', None); os.environ.pop('LEGIS_TODAY', None)
        FakeHttp.blocked = ()

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
        self.assertEqual(m['sources']['senate-member-data']['status'], 'ok')
        self.assertEqual(m['sources']['govinfo-billstatus']['status'], 'ok')
        self.assertEqual(m['sources']['senate-daily-press']['status'], 'ok')
        self.assertNotIn('congress-gov-api', m['sources'])
        self.assertNotIn('voteview', m['sources'])
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
        bill = load(self.tmp, 'us/bills/119/us-119-hconres-89.json')
        self.assertEqual(bill['sponsors'][0]['id'], 'J000298')
        self.assertEqual(bill['cosponsors'], 16)
        self.assertEqual(bill['policy_area'], 'International Affairs')
        self.assertTrue(bill['summary'].startswith('This concurrent resolution'))
        self.assertEqual(bill['actions'][0]['date'], '2026-09-24')
        self.assertEqual(bill['source']['id'], 'govinfo-billstatus')
        self.assertEqual(bill['source_updated_at'], '2026-09-26T10:56:33Z')
        up = load(self.tmp, 'us/upcoming.json')
        self.assertTrue(any(i['kind'] == 'floor' and i['body'] == 'us-house' for i in up['items']))
        senate_floor = [i for i in up['items'] if i['id'] == 'us-senate-floor-2026-09-28']
        self.assertEqual(len(senate_floor), 1)
        self.assertEqual(senate_floor[0]['time'], '15:00')
        self.assertIn('vote on passage', senate_floor[0]['note'])
        self.assertFalse(any(i['id'] == 'us-senate-convene-2026-09-28' for i in up['items']))
        counties = load(self.tmp, 'geo/us-ca/counties.json')
        cc = next(c for c in counties['counties'] if c['fips'] == '06013')
        self.assertTrue(cc['us_house']['current'] and cc['ca_senate'] and cc['ca_assembly'])
        states = load(self.tmp, 'geo/states.json')
        self.assertEqual(len(states['states']), 56)


    def test_senate_blocked_falls_back_to_voteview(self):
        import importlib
        from tools.legislation import federal, geo
        importlib.reload(federal)
        federal.Http = FakeHttp
        geo.Http = FakeHttp
        FakeHttp.blocked = ('https://www.senate.gov/legislative/LIS/roll_call_votes/',)
        federal.main([])
        m = load(self.tmp, 'manifest.json')
        self.assertEqual(m['sources']['us-senate-lis']['status'], 'partial')
        self.assertIn('Voteview', m['sources']['us-senate-lis']['error'])
        self.assertEqual(m['sources']['voteview']['status'], 'ok')
        vote = load(self.tmp, 'us/votes/us-senate-119-2-244.json')
        self.assertEqual(vote['source']['id'], 'voteview')
        self.assertEqual(vote['official_url'], 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.htm')
        self.assertEqual(vote['tally']['yes'], 49)
        self.assertEqual(vote['tally']['no'], 50)
        self.assertEqual(vote['bill_id'], 'us-119-hconres-89')
        self.assertEqual(len(vote['positions']), 100)
        self.assertIn(['A000382', 'X'], vote['positions'])      # Alsobrooks, not voting
        self.assertFalse(vote['passed'])
        self.assertTrue(vote['retrieved_at'])


class StaleIfError(unittest.TestCase):
    def test_failed_request_returns_the_cached_copy(self):
        from tools.legislation.common import Http, FetchError
        tmp = tempfile.mkdtemp()
        try:
            h = Http(cache_dir=tmp, retries=1)

            class Ok:
                status_code = 200
                headers = {'ETag': '"a"'}
                content = b'first'

            class Blocked:
                status_code = 403
                headers = {}
                content = b''

            h.session.get = lambda *a, **k: Ok()
            self.assertEqual(h.get('https://example.test/a', ttl=0)[0], b'first')
            h.session.get = lambda *a, **k: Blocked()
            body, meta = h.get('https://example.test/a', ttl=0)
            self.assertEqual(body, b'first')
            self.assertTrue(meta['stale'])
            self.assertEqual(h.stale_served, ['https://example.test/a'])
            with self.assertRaises(FetchError):
                h.get('https://example.test/never-fetched', ttl=0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Helpers(unittest.TestCase):
    def test_bill_codes_from_voteview(self):
        from tools.legislation.federal import bill_from_code
        self.assertEqual(bill_from_code('HCONRES89', 119), ('us-119-hconres-89', 'H.Con.Res. 89'))
        self.assertEqual(bill_from_code('S4668', 119), ('us-119-s-4668', 'S. 4668'))
        self.assertEqual(bill_from_code('PN9991', 119), (None, None))

    def test_daily_press_next_session(self):
        from datetime import date
        from tools.legislation.federal import parse_daily_press
        with open(os.path.join(FIX, 'dailypress-posts.json'), encoding='utf-8') as fh:
            posts = json.load(fh)
        item = parse_daily_press(posts, date(2026, 9, 26))
        self.assertEqual((item['date'], item['time']), ('2026-09-28', '15:00'))
        self.assertIsNone(parse_daily_press(posts, date(2026, 9, 29)))     # nothing announced beyond that
        older = parse_daily_press(posts[1:], date(2026, 9, 23))            # "until 10:00 a.m. tomorrow"
        self.assertEqual((older['date'], older['time']), ('2026-09-24', '10:00'))
        self.assertIn('Votes scheduled', older['note'])


if __name__ == '__main__':
    unittest.main()
