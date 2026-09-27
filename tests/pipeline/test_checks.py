"""The shrink guard and the Congress / session boundaries it depends on."""
import os
import unittest
from datetime import date


class ShrinkGuard(unittest.TestCase):
    def setUp(self):
        os.environ.pop('ALLOW_SHRINK', None)

    def check(self, prev, counts, prev_scopes=None, scopes=None):
        from tools.legislation.legislation_checks import shrink_failures
        return shrink_failures({'previous_counts': prev, 'counts': counts,
                                'previous_count_scopes': prev_scopes or {}, 'count_scopes': scopes or {}})

    def test_a_broken_feed_is_caught(self):
        out = self.check({'us_votes': 1600}, {'us_votes': 10}, {'us_votes': '119'}, {'us_votes': '119'})
        self.assertEqual(len(out), 1)
        self.assertIn('us_votes shrank from 1600 to 10', out[0])

    def test_a_new_congress_starts_again(self):
        self.assertEqual(self.check({'us_votes': 1600, 'us_bills': 500}, {'us_votes': 0, 'us_bills': 0},
                                    {'us_votes': '119', 'us_bills': '119'}, {'us_votes': '120', 'us_bills': '120'}), [])

    def test_a_new_california_session_starts_again(self):
        self.assertEqual(self.check({'ca_bills': 5065, 'ca_votes': 21546}, {'ca_bills': 12, 'ca_votes': 0},
                                    {'ca_bills': '20252026', 'ca_votes': '20252026'},
                                    {'ca_bills': '20272028', 'ca_votes': '20272028'}), [])

    def test_a_recess_does_not_block_publishing(self):
        self.assertEqual(self.check({'us_upcoming': 95, 'ca_upcoming': 40}, {'us_upcoming': 0, 'ca_upcoming': 0}), [])

    def test_county_windows_may_move_but_not_collapse(self):
        self.assertEqual(self.check({'ca_county_votes': 2756}, {'ca_county_votes': 1700}), [])
        self.assertEqual(len(self.check({'ca_county_votes': 2756}, {'ca_county_votes': 900})), 1)

    def test_first_night_without_scopes_still_compares(self):
        self.assertEqual(len(self.check({'us_votes': 1600}, {'us_votes': 10}, {}, {'us_votes': '119'})), 1)

    def test_override(self):
        os.environ['ALLOW_SHRINK'] = '1'
        try:
            self.assertEqual(self.check({'us_votes': 1600}, {'us_votes': 10}), [])
        finally:
            os.environ.pop('ALLOW_SHRINK', None)


class Boundaries(unittest.TestCase):
    def test_congress_changes_on_3_january(self):
        from tools.legislation.federal import congress_for_date, sessions_of_current_congress
        self.assertEqual(congress_for_date(date(2027, 1, 2)), 119)
        self.assertEqual(congress_for_date(date(2027, 1, 3)), 120)
        self.assertEqual(congress_for_date(date(2026, 9, 27)), 119)
        self.assertEqual(sessions_of_current_congress(date(2027, 1, 2)), (119, [2025, 2026]))
        self.assertEqual(sessions_of_current_congress(date(2027, 1, 3)), (120, [2027]))

    def test_california_session_changes_on_the_first_monday_of_december(self):
        from tools.legislation.california import current_session_year
        self.assertEqual(current_session_year(date(2026, 12, 6)), '20252026')
        self.assertEqual(current_session_year(date(2026, 12, 7)), '20272028')
        self.assertEqual(current_session_year(date(2028, 12, 3)), '20272028')   # 4 December 2028 is the first Monday
        self.assertEqual(current_session_year(date(2028, 12, 4)), '20292030')


if __name__ == '__main__':
    unittest.main()
