"""
Offline tests for the federal parsers, against fixture files captured from the
official sources on 2026-09-26. Run with:  python3 -m unittest discover -s tests/pipeline
"""
import json
import os
import unittest

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')


def fixture(name, mode='rb'):
    with open(os.path.join(FIX, name), mode, **({} if mode == 'rb' else {'encoding': 'utf-8'})) as fh:
        return fh.read()


class HouseTests(unittest.TestCase):
    def test_index(self):
        from tools.legislation.federal import parse_house_index
        rows = parse_house_index(fixture('house-evs-index-2026.html', 'r'))
        self.assertGreaterEqual(max(rows), 314)
        self.assertEqual(rows[314]['issue'], 'S 2403')
        self.assertEqual(rows[314]['result'], 'P')

    def test_roll(self):
        from tools.legislation.federal import parse_house_vote
        members = {}
        v = parse_house_vote(fixture('house-roll314.xml'), 2026, members)
        self.assertEqual(v['id'], 'us-house-119-2-314')
        self.assertEqual(v['bill_id'], 'us-119-s-2403')
        self.assertEqual(v['bill_label'], 'S. 2403')
        self.assertEqual(v['tally'], {'yes': 401, 'no': 14, 'present': 0, 'not_voting': 18})
        self.assertTrue(v['passed'])
        self.assertEqual(v['date'], '2026-09-16T19:05:00-04:00')
        self.assertEqual(len(v['positions']), 433)
        self.assertEqual(v['positions'][0], ['A000370', 'Y'])
        self.assertEqual(v['official_url'], 'https://clerk.house.gov/Votes/2026314')


class SenateTests(unittest.TestCase):
    def test_menu(self):
        from tools.legislation.federal import parse_senate_menu
        congress, session, rows = parse_senate_menu(fixture('senate-vote-menu-119-2.xml'))
        self.assertEqual((congress, session), (119, 2))
        self.assertEqual(rows[0]['number'], 244)
        self.assertEqual(rows[0]['issue'], 'H.Con.Res. 89')

    def test_vote(self):
        from tools.legislation.federal import parse_senate_vote
        members = {}
        v = parse_senate_vote(fixture('senate-vote-119-2-244.xml'), members, {'S428': 'A000382'})
        self.assertEqual(v['id'], 'us-senate-119-2-244')
        self.assertEqual(v['bill_id'], 'us-119-hconres-89')
        self.assertEqual(v['tally'], {'yes': 49, 'no': 50, 'present': 0, 'not_voting': 1})
        self.assertFalse(v['passed'])
        self.assertEqual(v['date'], '2026-09-24T13:45:00-04:00')
        self.assertEqual(v['source_updated_at'], '2026-09-24T15:05:00-04:00')
        self.assertEqual(v['positions'][0], ['A000382', 'X'])   # Alsobrooks, not voting, mapped through the lis index
        self.assertTrue(any(p[0].startswith('lis-') for p in v['positions']))  # unmapped senators get a provisional id
        self.assertEqual(len(v['positions']), 100)


class UpcomingTests(unittest.TestCase):
    def test_bills_this_week(self):
        from tools.legislation.federal import parse_bills_this_week, parse_bill_ref
        week, updated, items = parse_bills_this_week(fixture('house-billsthisweek-20260914.xml'))
        self.assertEqual(week, '2026-09-14')
        self.assertGreater(len(items), 50)
        self.assertEqual(items[0]['legis_num'], 'S. 283')
        self.assertEqual(parse_bill_ref(items[0]['legis_num'], 119), ('us-119-s-283', 'S. 283'))
        self.assertEqual(parse_bill_ref('H.R. 309', 119), ('us-119-hr-309', 'H.R. 309'))

    def test_hearings(self):
        from tools.legislation.federal import parse_senate_hearings
        rows = parse_senate_hearings(fixture('senate-hearings.xml'))
        self.assertTrue(rows)
        self.assertEqual(rows[0]['date'], '2026-09-28')
        self.assertEqual(rows[0]['time'], '14:00:00')


class BillRefTests(unittest.TestCase):
    def test_refs(self):
        from tools.legislation.federal import parse_bill_ref
        cases = {'H R 9497': ('us-119-hr-9497', 'H.R. 9497'), 'S 2403': ('us-119-s-2403', 'S. 2403'),
                 'H RES 123': ('us-119-hres-123', 'H.Res. 123'), 'H J RES 5': ('us-119-hjres-5', 'H.J.Res. 5'),
                 'S.J.Res. 12': ('us-119-sjres-12', 'S.J.Res. 12'), 'H.Con.Res. 89': ('us-119-hconres-89', 'H.Con.Res. 89'),
                 'PN 123': (None, None), '': (None, None), 'QUORUM': (None, None)}
        for text, want in cases.items():
            self.assertEqual(parse_bill_ref(text, 119), want, text)


class GeoTests(unittest.TestCase):
    def test_counties_and_relationships(self):
        from tools.legislation.geo import parse_counties, parse_relationship, parse_ab604
        counties = parse_counties(fixture('census-ca-counties.txt', 'r'))
        self.assertEqual(len(counties), 58)
        self.assertEqual(counties['06013']['name'], 'Contra Costa County')
        cd = parse_relationship(fixture('census-cd119-county-ca.txt', 'r'), 'GEOID_CD119_20')
        self.assertIn(6013, [int(k) for k in cd])
        self.assertTrue(cd['06013'])
        sldu = parse_relationship(fixture('census-sldu2024-county-ca.txt', 'r'), 'GEOID_SLDU2024_20')
        sldl = parse_relationship(fixture('census-sldl2024-county-ca.txt', 'r'), 'GEOID_SLDL2024_20')
        self.assertTrue(sldu['06013'] and sldl['06013'])
        ab = parse_ab604(fixture('ab604-head.csv', 'r'))
        self.assertIn('06065', ab)


class IdentityTests(unittest.TestCase):
    def test_members(self):
        from tools.legislation import identity
        data = json.loads(fixture('legislators-current-sample.json', 'r'))

        class FakeHttp:
            def get_json(self, url, ttl=0, **kw):
                return data, {'last_modified': 'Fri, 25 Sep 2026 10:00:00 GMT', 'fetched_at': '2026-09-26T00:00:00Z'}

        class FakeManifest:
            def describe(self, *a, **k): pass
            def ok(self, *a, **k): pass

        members = identity.load_members(FakeHttp(), FakeManifest())
        self.assertTrue(members)
        m = next(iter(members.values()))
        self.assertIn(m['body'], ('us-house', 'us-senate'))
        self.assertIn('bioguide', m['ids'])

    def test_departed_members_are_named(self):
        from tools.legislation import identity
        hist = json.loads(fixture('legislators-historical-sample.json', 'r'))

        class FakeHttp:
            def get_json(self, url, ttl=0, **kw):
                assert url == identity.HISTORICAL_URL
                return hist, {'last_modified': 'Fri, 25 Sep 2026 10:00:00 GMT'}

        class FakeManifest:
            def describe(self, *a, **k): pass
            def ok(self, *a, **k): pass
            def error(self, *a, **k): raise AssertionError('no error expected')

        members = {
            'T000489': {'id': 'T000489', 'body': 'us-house', 'name': 'Turner (TX)', 'state': 'TX', 'district': None, 'provisional': True},
            'lis-S350': {'id': 'lis-S350', 'body': 'us-senate', 'name': 'Marco Rubio', 'state': 'FL', 'district': None, 'provisional': True},
            'P000145': {'id': 'P000145', 'body': 'us-senate', 'name': 'Alex Padilla', 'state': 'CA'},
        }
        votes = [{'positions': [['lis-S350', 'Y'], ['P000145', 'N']]}, {'positions': [['T000489', 'X']]}]
        self.assertEqual(identity.resolve_departed(FakeHttp(), FakeManifest(), members, votes), 2)
        self.assertEqual(members['T000489']['name'], 'Sylvester Turner')
        self.assertEqual(members['T000489']['district'], 18)
        self.assertEqual(members['T000489']['left_office'], '2025-03-04')
        self.assertFalse(members['T000489']['active'])
        self.assertNotIn('lis-S350', members)
        self.assertEqual(members['R000595']['name'], 'Marco Rubio')
        self.assertEqual(members['R000595']['body'], 'us-senate')
        self.assertEqual(votes[0]['positions'], [['R000595', 'Y'], ['P000145', 'N']])
        self.assertNotIn('former', members['P000145'])


if __name__ == '__main__':
    unittest.main()
