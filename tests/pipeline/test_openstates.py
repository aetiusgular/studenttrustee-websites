"""Every other state's bills and votes from Open States' per-session bulk CSV files.

The session zip here is built in the layout Open States' exporter writes (CSV format 2.1,
openstates.org bulk/management/commands/bulk_export.py): {ST}/{session}/{ST}_{session}_{kind}.csv,
with the model fields as columns. The people are real Texas legislators from the national fixture."""
import csv
import io
import json
import os
import re
import shutil
import tempfile
import unittest
import zipfile

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'national')
HUGHES = 'ocd-person/8326538c-c907-43b2-a6db-76434036afd7'      # Texas Senate, district 1
CAMPBELL = 'ocd-person/9f80cd7f-1067-4322-8777-62bc129cd6f2'    # Texas Senate, district 25
FORMER = 'ocd-person/00000000-1111-2222-3333-444444444444'
SENATE, HOUSE, FINANCE = 'ocd-organization/senate', 'ocd-organization/house', 'ocd-organization/finance'


def table(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def session_zip(path, st='TX', session='89', committee=True):
    p = '%s/%s/%s_%s_' % (st, session, st, session)
    files = {
        'bills': [
            {'id': 'ocd-bill/b1', 'identifier': 'SB 12', 'title': 'Relating to\x07 public school\n governance.', 'classification': "['bill']", 'subject': "['Education']",
             'session_identifier': session, 'jurisdiction': 'Texas', 'organization_classification': 'upper'},
            {'id': 'ocd-bill/b2', 'identifier': 'HB 18', 'title': 'Relating to broadband.', 'classification': "['bill']", 'subject': '[]',
             'session_identifier': session, 'jurisdiction': 'Texas', 'organization_classification': 'lower'},
            {'id': 'ocd-bill/b3', 'identifier': 'SJR 3', 'title': 'Proposing a constitutional amendment.', 'classification': "['joint resolution']", 'subject': '[]',
             'session_identifier': session, 'jurisdiction': 'Texas', 'organization_classification': 'upper'},
        ],
        'bill_actions': [
            {'id': 1, 'bill_id': 'ocd-bill/b1', 'organization_id': SENATE, 'description': 'Filed', 'date': '2025-01-10', 'classification': "['introduction']", 'order': 0},
            {'id': 2, 'bill_id': 'ocd-bill/b1', 'organization_id': SENATE, 'description': 'Passed', 'date': '2025-03-04', 'classification': "['passage']", 'order': 2},
            {'id': 3, 'bill_id': 'ocd-bill/b1', 'organization_id': FINANCE, 'description': 'Reported favorably', 'date': '2025-02-20', 'classification': "['committee-passage']", 'order': 1},
        ],
        'bill_sponsorships': [
            {'id': 1, 'name': 'Hughes', 'entity_type': 'person', 'organization_id': '', 'person_id': HUGHES, 'bill_id': 'ocd-bill/b1', 'primary': 'True', 'classification': 'primary'},
            {'id': 2, 'name': 'Somebody Else', 'entity_type': 'person', 'organization_id': '', 'person_id': '', 'bill_id': 'ocd-bill/b1', 'primary': 'False', 'classification': 'cosponsor'},
            {'id': 3, 'name': 'Campbell', 'entity_type': 'person', 'organization_id': '', 'person_id': CAMPBELL, 'bill_id': 'ocd-bill/b1', 'primary': 'True', 'classification': 'primary'},
        ],
        'bill_sources': [{'id': 1, 'note': '', 'url': 'https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=SB12', 'bill_id': 'ocd-bill/b1'}],
        'votes': [
            {'id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'identifier': 'SV 1', 'motion_text': 'Third reading', 'motion_classification': "['passage']",
             'start_date': '2025-03-04', 'result': 'pass', 'organization_id': SENATE, 'bill_id': 'ocd-bill/b1', 'bill_action_id': '', 'jurisdiction': 'Texas', 'session_identifier': session},
            {'id': 'ocd-vote/bbbbbbbb-1111-2222-3333-444444444444', 'identifier': '', 'motion_text': 'Report favorably', 'motion_classification': "['committee-passage']",
             'start_date': '2025-02-20', 'result': 'pass', 'organization_id': FINANCE, 'bill_id': 'ocd-bill/b1', 'bill_action_id': '', 'jurisdiction': 'Texas', 'session_identifier': session},
            {'id': 'ocd-vote/cccccccc-1111-2222-3333-444444444444', 'identifier': '', 'motion_text': 'Adopt resolution (voice vote)', 'motion_classification': '[]',
             'start_date': '2025-05-01T10:30:00', 'result': 'pass', 'organization_id': HOUSE, 'bill_id': 'ocd-bill/b2', 'bill_action_id': '', 'jurisdiction': 'Texas', 'session_identifier': session},
            {'id': 'ocd-vote/dddddddd-1111-2222-3333-444444444444', 'identifier': '', 'motion_text': 'Final passage', 'motion_classification': "['passage']",
             'start_date': '2025-05-20', 'result': 'fail', 'organization_id': SENATE, 'bill_id': 'ocd-bill/b3', 'bill_action_id': '', 'jurisdiction': 'Texas', 'session_identifier': session},
        ],
        'vote_people': [
            {'id': 1, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'yes', 'voter_name': 'Hughes', 'voter_id': HUGHES, 'note': ''},
            {'id': 2, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'no', 'voter_name': 'Campbell', 'voter_id': CAMPBELL, 'note': ''},
            {'id': 3, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'excused', 'voter_name': 'Former Member', 'voter_id': FORMER, 'note': ''},
            {'id': 4, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'yes', 'voter_name': 'Unmatched Name', 'voter_id': '', 'note': ''},
            {'id': 5, 'vote_event_id': 'ocd-vote/bbbbbbbb-1111-2222-3333-444444444444', 'option': 'yes', 'voter_name': 'Hughes', 'voter_id': HUGHES, 'note': ''},
            {'id': 6, 'vote_event_id': 'ocd-vote/dddddddd-1111-2222-3333-444444444444', 'option': 'no', 'voter_name': 'Hughes', 'voter_id': HUGHES, 'note': ''},
            {'id': 7, 'vote_event_id': 'ocd-vote/dddddddd-1111-2222-3333-444444444444', 'option': 'abstain', 'voter_name': 'Campbell', 'voter_id': CAMPBELL, 'note': ''},
        ],
        'vote_counts': [
            {'id': 1, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'yes', 'value': 20},
            {'id': 2, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'no', 'value': 10},
            {'id': 3, 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444', 'option': 'excused', 'value': 1},
        ],
        'vote_sources': [{'id': 1, 'note': '', 'url': 'https://journals.senate.texas.gov/sjrnl/89r/html/89RSJ03-04-F.HTM', 'vote_event_id': 'ocd-vote/aaaaaaaa-1111-2222-3333-444444444444'},
                         {'id': 2, 'note': '', 'url': 'javascript:alert(1)', 'vote_event_id': 'ocd-vote/dddddddd-1111-2222-3333-444444444444'}],
        'organizations': [
            {'id': SENATE, 'name': 'Senate', 'classification': 'upper', 'parent_id': 'ocd-organization/legislature', 'jurisdiction_id': 'ocd-jurisdiction/country:us/state:tx/government'},
            {'id': HOUSE, 'name': 'House', 'classification': 'lower', 'parent_id': 'ocd-organization/legislature', 'jurisdiction_id': 'ocd-jurisdiction/country:us/state:tx/government'},
            {'id': FINANCE, 'name': 'Senate Finance', 'classification': 'committee', 'parent_id': SENATE, 'jurisdiction_id': 'ocd-jurisdiction/country:us/state:tx/government'},
        ],
    }
    if not committee:
        files['votes'] = [v for v in files['votes'] if v['organization_id'] != FINANCE]
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('README', 'Open States Data Export\n\nState: %s\nSession: %s\nCSV Format Version: 2.1\n' % (st, session))
        for kind, rows in files.items():
            z.writestr(p + kind + '.csv', table(rows))


SESSIONS = [
    {'identifier': '88', 'name': '88th Legislature', 'classification': 'primary', 'start_date': '2023-01-10', 'end_date': '2023-05-29',
     'downloads': [{'data_type': 'csv', 'url': 'https://data.openstates.org/csv/latest/TX_88_csv_x.zip', 'updated_at': '2024-01-01T00:00:00Z', 'created_at': ''}]},
    {'identifier': '89', 'name': '89th Legislature', 'classification': 'primary', 'start_date': '2025-01-14', 'end_date': '2025-06-02',
     'downloads': [{'data_type': 'csv', 'url': 'https://data.openstates.org/csv/latest/TX_89_csv_y.zip', 'updated_at': '2026-09-20T03:00:00Z', 'created_at': ''},
                   {'data_type': 'json', 'url': 'https://data.openstates.org/json/latest/TX_89_json_y.zip', 'updated_at': '2026-09-20T03:00:00Z', 'created_at': ''}]},
    {'identifier': '891', 'name': '89th Legislature, 1st called session', 'classification': 'special', 'start_date': '2025-07-21', 'end_date': '2025-08-15',
     'downloads': [{'data_type': 'csv', 'url': 'https://data.openstates.org/csv/latest/TX_891_csv_z.zip', 'updated_at': '2026-09-19T03:00:00Z', 'created_at': ''}]},
    {'identifier': '892', 'name': '89th Legislature, 2nd called session', 'classification': 'special', 'start_date': '2025-08-15', 'end_date': '2025-09-04', 'downloads': []},
    {'identifier': '90', 'name': '90th Legislature', 'classification': 'primary', 'start_date': '2027-01-12', 'end_date': None, 'downloads': []},
]


class Parts(unittest.TestCase):
    def test_sessions(self):
        from tools.legislation.openstates import choose_sessions, jurisdiction_code
        self.assertEqual([s['identifier'] for s in choose_sessions(SESSIONS, '2026-09-28')], ['89', '891'])
        self.assertEqual([s['identifier'] for s in choose_sessions(SESSIONS, '2024-06-01')], ['88'])
        # January 2027: the 90th has started but has no bulk file yet, so the 89th stays
        self.assertEqual([s['identifier'] for s in choose_sessions(SESSIONS, '2027-01-20')], ['89', '891'])
        with_90 = SESSIONS[:4] + [dict(SESSIONS[4], downloads=[{'data_type': 'csv', 'url': 'https://x/TX_90_csv_q.zip', 'updated_at': '2027-02-01T00:00:00Z'}])]
        self.assertEqual([s['identifier'] for s in choose_sessions(with_90, '2027-02-02')], ['90'])
        self.assertEqual(jurisdiction_code('ocd-jurisdiction/country:us/district:dc/government'), 'DC')
        self.assertEqual(jurisdiction_code('ocd-jurisdiction/country:us/territory:pr/government'), 'PR')

    def test_bill_keys_and_text(self):
        from tools.legislation.openstates import bill_key, clean
        self.assertEqual(bill_key('HB 18'), ('HB', 18))
        self.assertEqual(bill_key('SJR 3'), ('SJR', 3))
        self.assertEqual(bill_key('B26-0123'), ('B', 260123))
        self.assertEqual(clean('a\x07 b\n  c'), 'a b c')
        self.assertTrue(clean('x' * 900).endswith('…'))

    def test_the_jurisdiction_list_is_read_page_by_page(self):
        # the API refuses per_page above 52; states, DC and Puerto Rico are kept, cities are not
        from tools.legislation import openstates
        calls = []

        class Pages:
            def get_json(self, url, ttl=0, headers=None, params=None):
                calls.append(params)
                assert 1 <= params['per_page'] <= 52 and headers == {'X-API-KEY': 'k'}
                if params['page'] == 1:
                    return {'results': [{'id': 'ocd-jurisdiction/country:us/state:tx/government', 'legislative_sessions': SESSIONS},
                                        {'id': 'ocd-jurisdiction/country:us/state:il/place:chicago/government', 'legislative_sessions': []}],
                            'pagination': {'page': 1, 'max_page': 2}}, {}
                return {'results': [{'id': 'ocd-jurisdiction/country:us/district:dc/government', 'legislative_sessions': []}],
                        'pagination': {'page': 2, 'max_page': 2}}, {}
        got = openstates.fetch_sessions(Pages(), 'k')
        self.assertEqual(sorted(got), ['DC', 'TX'])
        self.assertEqual([c['page'] for c in calls], [1, 2])

    def test_vote_ids_end_in_eight_hex_digits(self):
        # the page finds a vote's file from its id alone, so the id's shape must not vary
        from tools.legislation.openstates import build_session
        tables = {'organizations': [{'id': SENATE, 'classification': 'upper'}],
                  'votes': [{'id': 'ocd-vote/zz-not-a-uuid', 'motion_text': 'Pass', 'start_date': '2025-03-04', 'organization_id': SENATE, 'result': 'pass'}]}
        _, votes = build_session('TX', {'identifier': '89', 'name': '89th Legislature'}, {}, tables, {})
        self.assertRegex(votes[0]['id'], r'^tx-89-upper-20250304-[0-9a-f]{8}$')


class Session(unittest.TestCase):
    def setUp(self):
        from tools.legislation import common, writer
        self.tmp = tempfile.mkdtemp()
        self.old = (common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH)
        common.DATA_DIR = writer.DATA_DIR = self.tmp
        common.Manifest.PATH = os.path.join(self.tmp, 'manifest.json')
        # Texas legislators, as states.py writes them
        from tools.legislation import states
        with open(os.path.join(FIX, 'people-tx.csv'), encoding='utf-8') as fh:
            members, _ = states.parse_people(fh.read(), 'TX', {})
        writer.write_json('us-tx/members.json', {'members': members})
        writer.write_json('us-tx/summary.json', {'state': 'TX', 'chambers': [], 'session': None, 'latest': []})
        self.fetched = []

    def tearDown(self):
        from tools.legislation import common, writer
        common.DATA_DIR, writer.DATA_DIR, common.Manifest.PATH = self.old
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('OPENSTATES_API_KEY', None)

    def load(self, rel):
        with open(os.path.join(self.tmp, rel), encoding='utf-8') as fh:
            return json.load(fh)

    def fetch(self, url, dest):
        self.fetched.append(url)
        session_zip(dest, session=url.split('_')[1])

    def test_a_session(self):
        from tools.legislation import openstates, writer
        status, note = openstates.run_state(None, 'TX', SESSIONS, '2026-09-28', set(), fetch=self.fetch)
        self.assertEqual(status, 'ok')
        self.assertEqual(len(self.fetched), 2)
        idx = self.load('us-tx/bills/89/index.json')
        self.assertEqual(sorted(idx['types']), ['HB', 'SB', 'SJR'])
        sb = self.load('us-tx/bills/89/SB-00.json')['bills']['tx-89-SB12']
        self.assertEqual(sb['title'], 'Relating to public school governance.')
        self.assertEqual([a['text'] for a in sb['actions']], ['Filed', 'Reported favorably', 'Passed'])
        self.assertEqual(sb['latest_action'], {'date': '2025-03-04', 'text': 'Passed'})
        self.assertTrue(sb['sponsors'][0]['id'].startswith('tx-') and sb['sponsors'][0]['primary'])
        self.assertEqual([x['name'] for x in sb['sponsors']], ['Hughes', 'Campbell', 'Somebody Else'])     # primary sponsors first
        self.assertIsNone(sb['sponsors'][2]['id'])
        self.assertEqual((sb['sponsors_total'], sb['session_name']), (3, '89th Legislature'))
        self.assertEqual(len(sb['vote_ids']), 2)
        self.assertTrue(all(re.match(r'^tx-89-(upper|lower)-\d{8}-[0-9a-f]{8}$', v) for v in sb['vote_ids']))

        month = self.load('us-tx/votes/89/upper-2025-03.json')
        row = dict(zip(month['columns'], month['rows'][0]))
        self.assertEqual((row['yes'], row['no'], row['other'], row['floor'], row['passed']), (20, 10, 1, 1, True))
        self.assertEqual(len(row['positions']), len(month['members']))
        self.assertIn('name:Unmatched Name', month['members'])
        # everyone who is not a current legislator is named in the file: former members, unmatched names
        self.assertEqual(month['names'], {'name:Unmatched Name': 'Unmatched Name', 'tx-00000000': 'Former Member'})
        hughes = [m for m in month['members'] if m.startswith('tx-8326538c')][0]
        self.assertEqual(row['positions'][month['members'].index(hughes)], 'Y')
        committee = dict(zip(month['columns'], self.load('us-tx/votes/89/upper-2025-02.json')['rows'][0]))
        self.assertEqual(committee['floor'], 0)
        voice = dict(zip(month['columns'], self.load('us-tx/votes/89/lower-2025-05.json')['rows'][0]))
        self.assertEqual((voice['positions'], voice['date']), ('', '2025-05-01'))
        failed = dict(zip(month['columns'], self.load('us-tx/votes/89/upper-2025-05.json')['rows'][0]))
        self.assertIsNone(failed['official_url'])                      # a javascript: link is dropped
        self.assertEqual(failed['passed'], False)

        rec = self.load('us-tx/records/upper-89.json')
        self.assertEqual(len(rec['votes']), 3)
        self.assertEqual(rec['members'][hughes], 'YYN')                # committee, floor, final passage in date order
        self.assertEqual(rec['floor'], [0, 1, 1])
        index = self.load('us-tx/votes/index.json')
        self.assertEqual([s['id'] for s in index['sessions']], ['89', '891'])
        summ = self.load('us-tx/summary.json')
        self.assertEqual(summ['session']['id'], '891')
        self.assertEqual(summ['latest'][0]['date'], '2025-05-20')
        self.assertEqual(summ['votes_source']['committee_votes'], 'kept')

        # every id leads to the file that holds it, as the page expects
        from tools.legislation import legislation_checks
        self.assertEqual(legislation_checks.state_vote_checks(), [])
        broken = self.load('us-tx/votes/89/upper-2025-03.json')
        broken['rows'][0][0] = 'tx-89-upper-20250401-aaaaaaaa'          # an April id in the March file
        writer.write_json('us-tx/votes/89/upper-2025-03.json', broken)
        self.assertTrue(legislation_checks.state_vote_checks())

        # nothing changed upstream: nothing is downloaded again
        self.fetched.clear()
        openstates.run_state(None, 'TX', SESSIONS, '2026-09-28', set(), fetch=self.fetch)
        self.assertEqual(self.fetched, [])
        # trimmed: rebuilt with floor votes only
        openstates.run_state(None, 'TX', SESSIONS, '2026-09-28', {'TX'}, fetch=self.fetch)
        self.assertEqual(len(self.fetched), 2)
        self.assertEqual(self.load('us-tx/records/upper-89.json')['floor'], [1, 1])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'us-tx/votes/89/upper-2025-02.json')))

    def test_an_ended_session_is_removed_once_the_new_one_is_in(self):
        from tools.legislation import openstates
        openstates.run_state(None, 'TX', SESSIONS, '2024-06-01', set(), fetch=self.fetch)       # the 88th
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'us-tx/records/upper-88.json')))
        openstates.run_state(None, 'TX', SESSIONS, '2026-09-28', set(), fetch=self.fetch)       # the 89th and a special session
        for gone in ('us-tx/bills/88', 'us-tx/votes/88', 'us-tx/records/upper-88.json'):
            self.assertFalse(os.path.exists(os.path.join(self.tmp, gone)), gone)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'us-tx/bills/89/index.json')))
        self.assertEqual(sorted(self.load('us-tx/openstates.json')['sessions']), ['89', '891'])

    def test_without_a_key(self):
        from tools.legislation import openstates
        os.environ.pop('OPENSTATES_API_KEY', None)
        openstates.main([])
        s = self.load('manifest.json')['sources']['openstates-bulk']
        self.assertEqual(s['status'], 'not_configured')
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'us-tx/votes/index.json')))

    def test_the_key_stays_out_of_errors(self):
        from tools.legislation import openstates

        class Failing:
            def __init__(self, *a, **k):
                pass

            def get_json(self, url, ttl=0, headers=None, params=None):
                raise RuntimeError('HTTP 401 for %s with %s' % (url, headers['X-API-KEY']))
        old = openstates.Http
        openstates.Http = Failing
        os.environ['OPENSTATES_API_KEY'] = 'secret-key-123'
        try:
            openstates.main([])
        finally:
            openstates.Http = old
        s = self.load('manifest.json')['sources']['openstates-bulk']
        self.assertNotIn('secret-key-123', json.dumps(s))
        self.assertIn('[key]', s['error'])


class Sizes(unittest.TestCase):
    def test_trim_plan(self):
        from tools.legislation.sizes import plan_trim, TRIM_AT
        votes = {'CA': 300 * 10 ** 6, 'TX': 120 * 10 ** 6, 'NY': 100 * 10 ** 6, 'VT': 5 * 10 ** 6}
        add, projected = plan_trim(TRIM_AT + 60 * 10 ** 6, votes, set(), share=lambda st: 0.5)
        self.assertEqual(add, ['TX'])                   # the largest state outside California first
        self.assertLessEqual(projected, TRIM_AT)
        add, _ = plan_trim(TRIM_AT + 150 * 10 ** 6, votes, {'TX'}, share=lambda st: 0.5)
        self.assertEqual(add, ['NY', 'VT'])


if __name__ == '__main__':
    unittest.main()
