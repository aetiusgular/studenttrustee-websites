"""California pipeline against a 30 KB slice of a real pubinfo dump (8 bills, every legislator)."""
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from datetime import date

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
SAMPLE = os.path.join(FIX, 'pubinfo_sample.zip')
TODAY = date(2026, 8, 20)


def load(*parts):
    with open(os.path.join(*parts), encoding='utf-8') as fh:
        return json.load(fh)


class Parsing(unittest.TestCase):
    def test_parse_dat_quotes_nulls_and_embedded_newlines(self):
        from tools.legislation.california import parse_dat
        rows = parse_dat('`a`\tNULL\t`multi\nline`\t42\n`b`\t`x`\t`y`\t7\n', ['s', 'n', 'm', 'i'])
        self.assertEqual(rows[0], {'s': 'a', 'n': None, 'm': 'multi\nline', 'i': '42'})
        self.assertEqual(rows[1]['s'], 'b')

    def test_pick_latest_dump(self):
        from tools.legislation.california import pick_latest_dump
        html = ('<a href="pubinfo_daily_Fri.zip">pubinfo_daily_Fri.zip</a> 2026-09-25 21:20 1.1G\n'
                '<a href="pubinfo_daily_Sat.zip">pubinfo_daily_Sat.zip</a> 2026-09-26 21:21 1.1G\n'
                '<a href="pubinfo_2025.zip">pubinfo_2025.zip</a> 2026-09-26 22:00 900M\n')
        url, stamp = pick_latest_dump(html)
        self.assertTrue(url.endswith('pubinfo_daily_Sat.zip'))
        self.assertEqual(stamp, '2026-09-26 21:21')

    def test_session_year(self):
        from tools.legislation.california import current_session_year
        self.assertEqual(current_session_year(date(2026, 9, 26)), '20252026')
        self.assertEqual(current_session_year(date(2025, 1, 6)), '20252026')
        self.assertEqual(current_session_year(date(2026, 12, 7)), '20272028')

    def test_vote_when_drops_fake_midnight_time(self):
        from tools.legislation.california import vote_when
        self.assertEqual(vote_when('2025-03-20 00:00:00'), '2025-03-20')
        self.assertEqual(vote_when('2025-03-20 11:15:05'), '2025-03-20T11:15:05-07:00')

    def test_house_of_location(self):
        from tools.legislation.california import house_of, body_of
        self.assertEqual(house_of('AFLOOR'), 'A')
        self.assertEqual(house_of('CX03'), 'A')
        self.assertEqual(house_of('CS64'), 'S')
        self.assertEqual(house_of('SF0450'), 'S')
        self.assertIsNone(house_of('CONFCM'))
        self.assertEqual(body_of('CONFCM'), 'ca-legislature')


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tools.legislation import california
        with zipfile.ZipFile(SAMPLE) as zf:
            cls.built = california.build(zf, '20252026', None, today=TODAY)

    def test_members_seats_and_vacancies(self):
        m = self.built['members']
        self.assertEqual(self.built['vacant'], ['ca-asm-03', 'ca-sen-10'])
        self.assertEqual(m['ca-sen-02']['name'], 'Mike McGuire')
        self.assertEqual(m['ca-sen-02']['party'], 'D')
        self.assertTrue(m['ca-sen-02']['active'])
        # a seat that changed hands mid-session keeps both people, separately
        self.assertTrue(m['ca-asm-63']['active'])
        self.assertEqual(m['ca-asm-63']['last'], 'Johnson')
        self.assertFalse(m['ca-asm-63-essayli']['active'])
        # the former occupant of a now-vacant seat is present but inactive
        self.assertFalse(m['ca-asm-03']['active'])
        # two spellings of one person are one member
        self.assertEqual([k for k in m if k.startswith('ca-asm-15')], ['ca-asm-15'])
        self.assertEqual(sum(1 for x in m.values() if x['active']), 118)

    def test_every_position_maps_to_a_member(self):
        m = self.built['members']
        unknown = [p[0] for v in self.built['votes'] for p in v['positions'] if p[0] not in m]
        self.assertEqual(unknown, [])
        # "Weber" on 2024-12-02 is Weber Pierson (SD39)
        scr1 = next(v for v in self.built['votes'] if v['id'] == 'ca-202520260SCR1-sfloor-20241202-1010')
        self.assertIn(['ca-sen-39', 'Y'], scr1['positions'])
        self.assertEqual(scr1['tally'], {'yes': 29, 'no': 9, 'present': 0, 'not_voting': 1})
        self.assertEqual(scr1['date'], '2024-12-02')
        self.assertTrue(scr1['floor'] and scr1['passed'] and scr1['result'] == 'PASS')

    def test_committee_votes_use_the_right_house(self):
        votes = self.built['votes']
        cx = [v for v in votes if v['location_code'].startswith('CX')]
        cs = [v for v in votes if v['location_code'].startswith('CS')]
        self.assertTrue(cx and cs)
        self.assertTrue(all(v['body'] == 'ca-assembly' and not v['floor'] for v in cx))
        self.assertTrue(all(v['body'] == 'ca-senate' for v in cs))
        self.assertTrue(all(p[0].startswith('ca-asm-') for v in cx for p in v['positions']))
        self.assertEqual(sum(1 for v in votes if not v['passed']), 1)

    def test_bills(self):
        b = self.built['bills']
        self.assertEqual(len(b), 8)
        ab1 = b['202520260AB1']
        self.assertEqual(ab1['label'], 'AB 1')
        self.assertEqual(ab1['title'], 'Residential property insurance: wildfire risk.')
        self.assertEqual(ab1['introduced'], '2024-12-02')
        self.assertEqual(ab1['status'], 'Chaptered')
        self.assertEqual(ab1['sponsors'][0]['name'], 'Connolly')
        self.assertEqual(len(ab1['vote_ids']), 7)
        self.assertTrue(ab1['official_url'].endswith('bill_id=202520260AB1'))
        self.assertEqual(b['202520260SB2']['location'], 'Sen Environmental Quality')

    def test_upcoming_window(self):
        up = self.built['upcoming']
        self.assertTrue(up)
        self.assertTrue(all(TODAY.isoformat() <= u['date'] <= '2026-10-04' for u in up))
        self.assertTrue(any(u['id'].startswith('ca-agenda-') and u['date'] == '2026-09-23' for u in up))
        floor = [u for u in up if u['kind'] == 'floor']
        self.assertEqual(floor[0]['category'], 'Assembly Bills - Third Reading File')
        self.assertEqual(floor[0]['body'], 'ca-senate')
        self.assertTrue(floor[0]['file_item'])
        hearing = [u for u in up if u['id'].startswith('ca-hearing-')]
        self.assertTrue(hearing)


class Outputs(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        os.environ['PUBINFO_ZIP'] = SAMPLE

    def tearDown(self):
        from tools.legislation import common, writer
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('PUBINFO_ZIP', None)

    def test_main_writes_every_file(self):
        from tools.legislation import california
        california.main([])
        m = load(self.tmp, 'manifest.json')
        self.assertEqual(m['sources']['ca-leginfo-pubinfo']['status'], 'ok')
        self.assertEqual(m['counts']['ca_bills'], 8)
        self.assertEqual(m['counts']['ca_votes'], 35)
        members = load(self.tmp, 'us-ca', 'members.json')
        self.assertEqual(members['vacant'], ['ca-asm-03', 'ca-sen-10'])
        self.assertEqual(members['members'][0]['id'], 'ca-asm-01')
        shards = load(self.tmp, 'us-ca', 'votes', 'index.json')
        self.assertEqual(shards['shards'][0]['file'], '20252026-assembly-2025-03.json')
        self.assertEqual(sum(s['votes'] for s in shards['shards']), 35)
        self.assertEqual(shards['locations']['SFLOOR'], 'Senate Floor')
        idx = load(self.tmp, 'us-ca', 'votes', '20252026-senate-2024-12.json')
        self.assertEqual(idx['columns'][0], 'id')
        self.assertEqual(idx['rows'][0][0], 'ca-202520260SCR1-sfloor-20241202-1010')
        self.assertEqual(idx['rows'][0][idx['columns'].index('location')], 'SFLOOR')
        per_bill = load(self.tmp, 'us-ca', 'votes', '20252026', '202520260AB1.json')
        self.assertEqual(len(per_bill['votes']), 7)
        rec = load(self.tmp, 'us-ca', 'records', 'senate-20252026-2025.json')
        self.assertEqual(len(rec['votes']), len(rec['floor']))
        self.assertEqual(len(rec['members']['ca-sen-02']), len(rec['votes']))
        self.assertIn('X', rec['codes'])
        bills = load(self.tmp, 'us-ca', 'bills', '20252026', 'index.json')
        self.assertEqual(bills['types']['AB']['bills'], 3)
        ab = load(self.tmp, 'us-ca', 'bills', '20252026', 'index-AB.json')
        self.assertEqual([r[1] for r in ab['rows']], ['AB 1', 'AB 2', 'AB 173'])
        shard = load(self.tmp, 'us-ca', 'bills', '20252026', 'AB-00.json')
        self.assertIn('202520260AB1', shard['bills'])
        self.assertIn('202520260AB2', shard['bills'])
        shard = load(self.tmp, 'us-ca', 'bills', '20252026', 'AB-01.json')
        self.assertIn('202520260AB173', shard['bills'])
        latest = load(self.tmp, 'us-ca', 'latest.json')
        self.assertLessEqual(len(latest['rows']), 30)
        search = load(self.tmp, 'search', 'us-ca.json')
        self.assertTrue(any(r[0] == 'member' and r[1] == 'ca-sen-02' for r in search['rows']))
        self.assertTrue(any(r[0] == 'bill' and r[1] == '202520260SB795' for r in search['rows']))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'us-ca', 'upcoming.json')))
        from tools.legislation import legislation_checks
        self.assertEqual(legislation_checks.run(), [])
        # a second run with identical input rewrites nothing
        before = {p: os.path.getmtime(os.path.join(d, p)) for d, _, fs in os.walk(self.tmp) for p in fs}
        california.main([])
        after = {p: os.path.getmtime(os.path.join(d, p)) for d, _, fs in os.walk(self.tmp) for p in fs}
        changed = [p for p in before if before[p] != after.get(p) and p != 'manifest.json']
        self.assertEqual(changed, [])


if __name__ == '__main__':
    unittest.main()
