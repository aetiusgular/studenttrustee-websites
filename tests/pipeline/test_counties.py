"""County pipeline against cached Legistar responses for San Diego County (6 meetings, 105 votes)."""
import json
import os
import shutil
import tempfile
import unittest
import zipfile

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
ZIP = os.path.join(FIX, 'legistar-sdcounty.zip')
TODAY = '2026-09-26'


def load(*parts):
    with open(os.path.join(*parts), encoding='utf-8') as fh:
        return json.load(fh)


class FakeHttp:
    """Serves the zipped Legistar responses; every other URL is a 404 (the link-only counties)."""
    def __init__(self, *a, **k):
        self.stale_served = []
        self.zf = zipfile.ZipFile(ZIP)
        self.urls = json.loads(self.zf.read('urls.json'))
        self.cache_dir = tempfile.mkdtemp()

    def get(self, url, ttl=0, headers=None, params=None):
        from tools.legislation.common import FetchError
        name = self.urls.get(url)
        if not name:
            raise FetchError('HTTP 404 for %s' % url)
        return self.zf.read(name), {'from_cache': False}

    def get_text(self, url, ttl=0, encoding='utf-8', **kw):
        b, m = self.get(url, ttl, **kw)
        return b.decode(encoding), m

    def get_json(self, url, ttl=0, **kw):
        b, m = self.get(url, ttl, **kw)
        return json.loads(b.decode('utf-8')), m


class Counties(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer, counties, geo
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        os.environ['LEGIS_TODAY'] = TODAY
        os.environ['LEGIS_COUNTIES'] = '06073,06001'
        counties.Http = FakeHttp
        # the county list normally comes from geo/us-ca/counties.json; a minimal one is enough here
        writer.write_json('geo/us-ca/counties.json', {'counties': [{'fips': '06073', 'name': 'San Diego County', 'slug': 'san-diego'}, {'fips': '06001', 'name': 'Alameda County', 'slug': 'alameda'}]})
        self.geo = geo

    def tearDown(self):
        from tools.legislation import common, writer
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('LEGIS_TODAY', None)
        os.environ.pop('LEGIS_COUNTIES', None)

    def test_vote_values_from_every_county(self):
        from tools.legislation.counties import vote_code
        for label, code in [('Aye', 'Y'), ('Ayes', 'Y'), ('AYE', 'Y'), ('Yes', 'Y'), ('Nay', 'N'), ('Noes', 'N'), ('NO', 'N'),
                            ('Absent', 'X'), ('NOT PRESENT', 'X'), ('Recuse', 'R'), ('Recused', 'R'), ('Abstain', 'A'),
                            ('Abstained', 'A'), ('Something new', 'O')]:
            self.assertEqual(vote_code(label), code, label)

    def test_sitting_names(self):
        from tools.legislation.counties import sitting
        self.assertEqual(sitting('BOARD OF SUPERVISORS - LAND USE'), 'Land Use')
        self.assertEqual(sitting('Special Meeting of the Board of Supervisors'), 'Special Meeting')
        self.assertEqual(sitting('BOARD OF SUPERVISORS'), '')

    def test_san_diego(self):
        from tools.legislation import counties
        counties.main([])
        m = load(self.tmp, 'manifest.json')
        sd = m['sources']['county-06073']
        self.assertEqual(sd['status'], 'ok')
        self.assertEqual(m['counts']['ca_counties_with_votes'], 1)
        # a link-only county whose URL check 404s in this harness
        self.assertEqual(m['sources']['county-06001']['status'], 'error')
        board = load(self.tmp, 'us-ca', 'counties', '06073', 'board.json')
        self.assertEqual(board['coverage'], 'votes')
        self.assertEqual(board['body_name'], 'San Diego Board of Supervisors')
        names = sorted(x['name'] for x in board['members'] if not x.get('provisional'))
        self.assertEqual(names, ['Jim Desmond', 'Joel Anderson', 'Monica Montgomery Steppe', 'Paloma Aguirre', 'Terra Lawson-Remer'])
        self.assertEqual(board['counts']['meetings'], 6)
        self.assertEqual(board['counts']['votes'], 105)
        self.assertEqual([x['month'] for x in board['vote_months']], ['2026-08', '2026-09'])
        self.assertTrue(all(x['status'] == 'held' for x in board['meetings']))
        self.assertIn('Land Use', board['meetings'][0]['title'])
        self.assertEqual(board['meetings'][1]['title'], 'San Diego Board of Supervisors')
        votes = load(self.tmp, 'us-ca', 'counties', '06073', 'votes-2026-09.json')
        cols = votes['columns']
        self.assertEqual(len(votes['members']), 5)
        row = votes['rows'][0]
        self.assertTrue(row[cols.index('id')].startswith('ca-06073-bos-vote-202609'))
        self.assertEqual(len(row[cols.index('positions')]), 5)
        self.assertEqual(row[cols.index('yes')] + row[cols.index('no')] + row[cols.index('other')], 5)
        self.assertTrue(row[cols.index('matter_id')] in votes['matters'])
        idx = load(self.tmp, 'us-ca', 'counties', 'index.json')
        sd_entry = [c for c in idx['counties'] if c['fips'] == '06073'][0]
        self.assertEqual(sd_entry['members'], 5)
        self.assertEqual(sd_entry['latest_meeting'], '2026-09-16')
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'us-ca', 'counties', 'upcoming.json')))

    def test_latest_across_counties(self):
        from tools.legislation import counties
        os.environ.pop('LEGIS_COUNTIES', None)
        counties.main([])
        latest = load(self.tmp, 'us-ca', 'counties', 'latest.json')
        cols = latest['columns']
        self.assertTrue(latest['rows'])
        self.assertTrue(all(r[cols.index('body')] == 'ca-06073-bos' for r in latest['rows']))
        dates = [r[cols.index('date')] for r in latest['rows']]
        self.assertEqual(dates, sorted(dates, reverse=True))
        self.assertTrue(all(r[cols.index('recorded')] for r in latest['rows']))


if __name__ == '__main__':
    unittest.main()
