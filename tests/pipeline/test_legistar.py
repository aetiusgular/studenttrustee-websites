"""Finding county governments on Legistar outside California, and collecting their votes.
The collection test reuses the saved San Diego responses as if they were a Texas county's."""
import json
import os
import shutil
import tempfile
import unittest
from datetime import date

from tests.pipeline.test_counties import FakeHttp as LegistarHttp, TODAY, load


class FakeResponse:
    def __init__(self, status, text=''):
        self.status_code = status
        self.text = text

    def json(self):
        return json.loads(self.text)


class FakeSession:
    """Answers like Legistar: known clients return bodies and a public site; others a 500."""
    def __init__(self, clients):
        self.clients = clients      # client -> (bodies, insite html)

    def get(self, url, timeout=None):
        from tools.legislation import legistar
        for client, (bodies, html) in self.clients.items():
            if url == legistar.API % (client, 'bodies?$top=500'):
                return FakeResponse(200, json.dumps(bodies))
            if url == legistar.INSITE % client:
                return FakeResponse(200, html)
        if 'webapi.legistar.com' in url:
            return FakeResponse(500, '{"Message":"An error has occurred.","ExceptionMessage":"LegistarConnectionString setting is not set up in InSite for client"}')
        return FakeResponse(404)


def page(title, links=()):
    return '<html><head><title>%s</title></head><body>%s</body></html>' % (title, ''.join('<a href="https://%s/">x</a>' % h for h in links))


BOARD = [{'BodyId': 5, 'BodyName': 'Commissioners Court', 'BodyTypeName': 'Primary Legislative Body', 'BodyActiveFlag': 1},
         {'BodyId': 6, 'BodyName': 'Commissioners Court - Special Session', 'BodyTypeName': 'Secondary Legislative Body', 'BodyActiveFlag': 1},
         {'BodyId': 7, 'BodyName': 'Flood Control District', 'BodyTypeName': 'Board', 'BodyActiveFlag': 1}]
CITY = [{'BodyId': 1, 'BodyName': 'City Council', 'BodyTypeName': 'Primary Legislative Body', 'BodyActiveFlag': 1}]


def county(fips, name, st, site=None):
    return {'fips': fips, 'name': name, 'state': st, 'board': {'name': 'x', 'url': site, 'source_url': site} if site else {'name': 'x'}}


class Probe(unittest.TestCase):
    def test_candidates(self):
        from tools.legislation.legistar import candidates
        self.assertEqual(candidates('Harris County', 'TX', 'https://www.harriscountytx.gov/'), ['harriscountytx', 'harriscounty', 'harris-county', 'harris'])
        self.assertEqual(candidates("Prince George's County", 'MD')[:2], ['princegeorgescountymd', 'princegeorgescounty'])
        self.assertEqual(candidates('St. Charles Parish', 'LA')[0], 'stcharlesparish')
        self.assertIn('miami-dade-county', candidates('Miami-Dade County', 'FL'))

    def test_pick_body(self):
        from tools.legislation.legistar import pick_body
        self.assertEqual(pick_body(BOARD, 'Commissioners Court'), {'id': 5, 'name': 'Commissioners Court'})
        self.assertIsNone(pick_body(CITY))
        self.assertIsNone(pick_body([{'BodyId': 3, 'BodyName': 'Common Council', 'BodyTypeName': 'Primary Legislative Body'}]))

    def test_confirmation(self):
        from tools.legislation import legistar
        unique = {'harris county': 3, 'alachua county': 1, 'lake county': 12, 'pinellas county': 1}
        s = FakeSession({
            'harriscountytx': (BOARD, page('Harris County - Calendar', ['www.harriscountytx.gov'])),
            'alachua': (BOARD, page('Alachua County, FL - Calendar')),
            'lakecounty': (BOARD, page('Lake County Illinois - Meetings')),
            'pinellas': (BOARD, page('Pinellas County - Calendar')),
            'maricopa': (CITY, page('City of Maricopa - Calendar')),
        })
        res = legistar.probe_county(s, county('48201', 'Harris County', 'TX', 'https://www.harriscountytx.gov/'), 'Commissioners Court', unique)
        self.assertEqual((res['client'], res['confirmed_by']), ('harriscountytx', 'links harriscountytx.gov'))
        res = legistar.probe_county(s, county('12001', 'Alachua County', 'FL', 'https://alachuacounty.us/'), None, unique)
        self.assertEqual(res['confirmed_by'], 'titled Alachua County, FL')
        self.assertEqual(legistar.probe_county(s, county('17097', 'Lake County', 'IL'), None, unique)['confirmed_by'], 'titled Lake County Illinois')
        self.assertEqual(legistar.probe_county(s, county('12069', 'Lake County', 'FL'), None, unique)['result'], 'unconfirmed')
        self.assertTrue(legistar.probe_county(s, county('12103', 'Pinellas County', 'FL', 'https://pinellas.gov/'), None, unique)['confirmed_by'].startswith('titled Pinellas County'))
        self.assertEqual(legistar.probe_county(s, county('04013', 'Maricopa County', 'AZ'), None, unique)['result'], 'unconfirmed')
        self.assertEqual(legistar.probe_county(s, county('48453', 'Travis County', 'TX'), None, unique)['result'], 'none')

    def test_shared_client_goes_to_the_county_it_links(self):
        from tools.legislation.legistar import settle
        state = {'clients': {'32003': {'client': 'clark', 'confirmed_by': 'links clarkcountynv.gov'},
                             '53011': {'client': 'clark', 'confirmed_by': 'titled Clark County'},
                             '21057': {'client': 'cumberlandcounty', 'confirmed_by': 'titled Cumberland County'},
                             '23005': {'client': 'cumberlandcounty', 'confirmed_by': 'titled Cumberland County'}},
                 'checked': {}}
        settle(state)
        self.assertEqual(sorted(state['clients']), ['32003'])
        self.assertEqual(state['checked']['53011']['result'], 'shared clark')


class Nightly(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer, legistar
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH)
        self.initial = legistar.INITIAL
        legistar.INITIAL = os.path.join(self.tmp, 'no-initial.json')
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        os.environ['LEGIS_TODAY'] = TODAY

    def tearDown(self):
        from tools.legislation import common, writer, legistar
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        legistar.INITIAL = self.initial
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('LEGIS_TODAY', None)

    def test_first_night_starts_from_the_initial_list(self):
        from tools.legislation import legistar
        legistar.INITIAL = self.initial
        state = legistar.probe([], date(2026, 9, 28), prober=lambda c: {'result': 'none'})
        self.assertIn('48201', state['clients'])
        self.assertEqual(state['clients']['48201']['client'], 'harriscountytx')
        seed = legistar.load_seed()
        self.assertEqual(seed['47037']['client'], 'nashville')

    def test_rotation(self):
        from tools.legislation import legistar
        counties = [county('%05d' % n, 'County %d' % n, 'TX') for n in range(48001, 48091)]
        seen = []

        def prober(c):
            seen.append(c['fips'])
            return {'client': 'c%s' % c['fips'], 'body': {'id': 1, 'name': 'Commissioners Court'}, 'confirmed_by': 'links x'} if c['fips'] == '48015' else {'result': 'none'}
        day = date(2026, 9, 28)
        legistar.probe(counties, day, prober=prober)            # the first night tries every county not tried yet
        self.assertEqual(len(seen), 90)
        seen.clear()
        state = legistar.probe(counties, day, prober=prober)    # after that, a thirtieth a night
        self.assertEqual(sorted(seen), sorted(c['fips'] for c in counties if legistar.due(c['fips'], day)))
        self.assertEqual(list(state['clients']), ['48015'])

    def test_collect_a_texas_board(self):
        from tools.legislation import legistar
        clients = {'48201': {'state': 'TX', 'name': 'Harris County', 'client': 'sdcounty', 'body': {'id': 181, 'name': 'BOARD OF SUPERVISORS'},
                             'confirmed_by': 'links harriscountytx.gov'}}
        geo = {'48201': {'fips': '48201', 'name': 'Harris County', 'slug': 'harris', 'state': 'TX',
                         'board': {'name': 'Commissioners Court', 'url': 'https://www.harriscountytx.gov/'}}}
        from tools.legislation.common import Manifest
        m = Manifest()
        index, upcoming, latest = legistar.collect(LegistarHttp(), m, clients, geo)
        self.assertEqual(len(index), 1)
        e = index[0]
        self.assertEqual((e['state'], e['coverage'], e['platform'], e['slug']), ('TX', 'votes', 'Legistar', 'harris'))
        self.assertEqual(e['body_name'], 'Harris County Commissioners Court')
        board = load(self.tmp, 'us-tx', 'counties', '48201', 'board.json')
        self.assertTrue(all(x['id'].startswith('tx-48201-bos-') for x in board['members']))
        self.assertTrue(all(x['tz'] == 'America/Chicago' for x in board['meetings']))
        self.assertEqual(board['counts']['votes'], 105)
        self.assertEqual(board['urls']['website'], 'https://www.harriscountytx.gov/')
        month = load(self.tmp, 'us-tx', 'counties', '48201', 'votes-2026-09.json')
        self.assertTrue(month['rows'][0][0].startswith('tx-48201-bos-vote-202609'))
        self.assertTrue(latest and all(r[2] == 'tx-48201-bos' for r in latest))
        self.assertEqual(m.data['sources']['county-48201']['status'], 'ok')
        from tools.legislation import legislation_checks, writer
        writer.write_json('counties/index.json', {'counties': index})
        self.assertEqual(legislation_checks.county_board_checks(), [])
        board['members'][0]['id'] = 'ca-06073-bos-1'
        writer.write_json('us-tx/counties/48201/board.json', board)
        self.assertTrue(legislation_checks.county_board_checks())

    def test_new_boards_join_a_few_a_night(self):
        from tools.legislation import legistar
        from tools.legislation.common import Manifest
        old = legistar.NEW_BOARDS
        legistar.NEW_BOARDS = 1
        try:
            clients = {f: {'state': 'TX', 'name': 'County %s' % f, 'client': 'sdcounty', 'body': {'id': 181, 'name': 'BOARD OF SUPERVISORS'}, 'confirmed_by': 'x'}
                       for f in ('48201', '48203', '48205')}
            geo = {f: {'fips': f, 'name': 'County %s' % f, 'slug': f, 'board': {}} for f in clients}
            index, _, _ = legistar.collect(LegistarHttp(), Manifest(), clients, geo)
            self.assertEqual([e['fips'] for e in index], ['48201'])
            index, _, _ = legistar.collect(LegistarHttp(), Manifest(), clients, geo)     # the next night: one more
            self.assertEqual([e['fips'] for e in index], ['48201', '48203'])
        finally:
            legistar.NEW_BOARDS = old

    def test_time_zones(self):
        from tools.legislation.legistar import tz_of
        self.assertEqual(tz_of('TX', '48201'), 'America/Chicago')
        self.assertEqual(tz_of('TX', '48141'), 'America/Denver')          # El Paso
        self.assertEqual(tz_of('TN', '47093'), 'America/New_York')        # Knox
        self.assertEqual(tz_of('TN', '47157'), 'America/Chicago')         # Shelby


if __name__ == '__main__':
    unittest.main()
