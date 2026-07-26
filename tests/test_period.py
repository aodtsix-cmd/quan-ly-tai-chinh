"""Tests for src/period.py — the financial-period math every retrofitted
risk.py function and the new period_budgets feature depends on. Getting a
boundary date wrong here silently corrupts every number downstream, so this
is tested more thoroughly than the rest of the app has been so far (per
docs/THIET-KE.md Part 6's own, previously-unfulfilled principle: "Có kiểm
thử cho phần tính toán tài chính — sai số tiền là sai nghiêm trọng")."""

import sqlite3
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import period


class PeriodBoundsTests(unittest.TestCase):
    def test_middle_of_period(self):
        start, end = period.period_bounds(date(2026, 7, 20), start_day=15)
        self.assertEqual(start, date(2026, 7, 15))
        self.assertEqual(end, date(2026, 8, 14))

    def test_day_before_boundary_belongs_to_previous_period(self):
        start, end = period.period_bounds(date(2026, 7, 14), start_day=15)
        self.assertEqual(start, date(2026, 6, 15))
        self.assertEqual(end, date(2026, 7, 14))

    def test_boundary_day_itself_starts_new_period(self):
        start, end = period.period_bounds(date(2026, 7, 15), start_day=15)
        self.assertEqual(start, date(2026, 7, 15))
        self.assertEqual(end, date(2026, 8, 14))

    def test_year_boundary(self):
        start, end = period.period_bounds(date(2026, 1, 5), start_day=15)
        self.assertEqual(start, date(2025, 12, 15))
        self.assertEqual(end, date(2026, 1, 14))

    def test_start_day_1_matches_plain_calendar_month(self):
        start, end = period.period_bounds(date(2026, 7, 20), start_day=1)
        self.assertEqual(start, date(2026, 7, 1))
        self.assertEqual(end, date(2026, 7, 31))

    def test_start_day_clamps_in_short_month(self):
        # start_day=31: the period "starting" March 31st runs through the day
        # before April's clamped equivalent (day 30, since April has no 31st)
        # — i.e. ends April 29th.
        start, end = period.period_bounds(date(2026, 4, 25), start_day=31)
        self.assertEqual(start, date(2026, 3, 31))
        self.assertEqual(end, date(2026, 4, 29))


class PeriodIdTests(unittest.TestCase):
    def test_period_id_for_matches_start_date(self):
        self.assertEqual(period.period_id_for(date(2026, 7, 20), start_day=15), "2026-07")
        self.assertEqual(period.period_id_for(date(2026, 7, 14), start_day=15), "2026-06")

    def test_round_trip_id_to_bounds_and_back(self):
        d = date(2026, 7, 20)
        pid = period.period_id_for(d, start_day=15)
        start, end = period.period_bounds_for_id(pid, start_day=15)
        self.assertEqual((start, end), period.period_bounds(d, start_day=15))

    def test_shift_forward_and_backward(self):
        self.assertEqual(period.shift_period_id("2026-07", 1, start_day=15), "2026-08")
        self.assertEqual(period.shift_period_id("2026-07", -1, start_day=15), "2026-06")
        self.assertEqual(period.shift_period_id("2026-12", 1, start_day=15), "2027-01")
        self.assertEqual(period.shift_period_id("2026-07", 0, start_day=15), "2026-07")


class RecentPeriodIdsTests(unittest.TestCase):
    def test_excludes_current_by_default(self):
        ids = period.recent_period_ids_for(current_id="2026-07", n=3, start_day=15)
        self.assertEqual(ids, ["2026-04", "2026-05", "2026-06"])

    def test_includes_current_when_requested(self):
        ids = period.recent_period_ids_for(current_id="2026-07", n=3, start_day=15, include_current=True)
        self.assertEqual(ids, ["2026-05", "2026-06", "2026-07"])


class DaysElapsedTests(unittest.TestCase):
    def test_elapsed_plus_remaining_equals_total(self):
        info = period.days_elapsed_and_remaining_for(date(2026, 7, 20), start_day=15)
        self.assertEqual(info["elapsed_days"] + info["remaining_days"], info["total_days"])
        self.assertEqual(info["period_start"], date(2026, 7, 15))
        self.assertEqual(info["period_end"], date(2026, 8, 14))
        self.assertEqual(info["elapsed_days"], 6)  # 15,16,17,18,19,20 -> 6 days elapsed

    def test_first_day_of_period_elapsed_is_1(self):
        info = period.days_elapsed_and_remaining_for(date(2026, 7, 15), start_day=15)
        self.assertEqual(info["elapsed_days"], 1)

    def test_last_day_of_period_remaining_is_0(self):
        info = period.days_elapsed_and_remaining_for(date(2026, 8, 14), start_day=15)
        self.assertEqual(info["remaining_days"], 0)


class AppSettingsTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.cursor = self.conn.cursor()

    def test_falls_back_to_default_when_unset(self):
        self.assertEqual(period.get_period_start_day(self.cursor), 15)

    def test_set_then_get_round_trip(self):
        period.set_period_start_day(self.cursor, 10)
        self.assertEqual(period.get_period_start_day(self.cursor), 10)

    def test_set_twice_upserts_not_duplicates(self):
        period.set_period_start_day(self.cursor, 10)
        period.set_period_start_day(self.cursor, 20)
        self.cursor.execute("SELECT COUNT(*) c FROM app_settings WHERE key='period_start_day'")
        self.assertEqual(self.cursor.fetchone()["c"], 1)
        self.assertEqual(period.get_period_start_day(self.cursor), 20)

    def test_rejects_out_of_range_day(self):
        with self.assertRaises(ValueError):
            period.set_period_start_day(self.cursor, 0)
        with self.assertRaises(ValueError):
            period.set_period_start_day(self.cursor, 32)


if __name__ == "__main__":
    unittest.main()
