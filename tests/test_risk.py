"""Tests for the risk.py retrofit from calendar-month to financial-period
math (period.py). Every expected number here is hand-computed, not derived
from the code under test — the whole point is to catch a boundary mistake
that the implementation itself would also "agree with" if copy-pasted."""

import sqlite3
import sys
import unittest
from datetime import date
from pathlib import Path

SRC_DIR = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(SRC_DIR))

import risk
import period


def build_test_db():
    """In-memory DB with the real schema + migrations applied, period_start_day=15."""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    conn.executescript((SRC_DIR / "schema.sql").read_text(encoding="utf-8"))
    for migration in ["001_ai_infra.sql", "002_period_settings.sql", "003_period_budgets.sql",
                      "004_goals.sql", "005_simulations.sql"]:
        conn.executescript((SRC_DIR / "migrations" / migration).read_text(encoding="utf-8"))
    return conn


def seed_account_and_categories(conn):
    conn.execute(
        "INSERT INTO accounts (id, name, type, current_balance, is_liquid) VALUES (1, 'Test', 'bank', 5000000, 1)"
    )
    conn.execute(
        "INSERT INTO categories (id, name_vi, name_en, kind, necessity) VALUES (1, 'Thiết yếu', 'Essential', 'expense', 'essential')"
    )
    conn.execute(
        "INSERT INTO categories (id, name_vi, name_en, kind, necessity) VALUES (2, 'Tùy chọn', 'Optional', 'expense', 'optional')"
    )
    conn.execute(
        "INSERT INTO categories (id, name_vi, name_en, kind) VALUES (3, 'Thu nhập', 'Income', 'income')"
    )
    conn.commit()


def insert_tx(conn, occurred_at, amount, direction, category_id=None, account_id=1, source="manual"):
    conn.execute(
        """INSERT INTO transactions (occurred_at, amount, direction, account_id, category_id, description, source, is_reviewed)
           VALUES (?, ?, ?, ?, ?, '', ?, 1)""",
        (occurred_at, amount, direction, account_id, category_id, source),
    )


class PeriodEssentialExpenseTests(unittest.TestCase):
    """as_of = 2026-07-20 -> current period is 2026-07-15..2026-08-14 (excluded).
    Prior periods (period_id, bounds):
      2026-06: 06-15..07-14
      2026-05: 05-15..06-14
      2026-04: 04-15..05-14
    """

    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_averages_last_3_periods_with_data(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 900_000, "out", category_id=1)  # period 2026-06
        insert_tx(self.conn, "2026-05-20 10:00:00", 1_100_000, "out", category_id=1)  # period 2026-05
        insert_tx(self.conn, "2026-04-20 10:00:00", 1_000_000, "out", category_id=1)  # period 2026-04
        self.conn.commit()
        avg = risk.get_average_period_essential_expense(self.cursor, periods=3, as_of=self.as_of)
        self.assertAlmostEqual(avg, (900_000 + 1_100_000 + 1_000_000) / 3)

    def test_excludes_current_open_period(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 5_000_000, "out", category_id=1)  # current period, must be excluded
        insert_tx(self.conn, "2026-06-20 10:00:00", 900_000, "out", category_id=1)
        self.conn.commit()
        avg = risk.get_average_period_essential_expense(self.cursor, periods=3, as_of=self.as_of)
        self.assertAlmostEqual(avg, 900_000)  # only the completed period counts

    def test_boundary_date_belongs_to_correct_period(self):
        # 2026-07-14 is the LAST day of period 2026-06 (06-15..07-14), not current.
        insert_tx(self.conn, "2026-07-14 23:59:00", 500_000, "out", category_id=1)
        # 2026-07-15 is the FIRST day of the current period 2026-07, must be excluded.
        insert_tx(self.conn, "2026-07-15 00:00:01", 999_999, "out", category_id=1)
        self.conn.commit()
        avg = risk.get_average_period_essential_expense(self.cursor, periods=1, as_of=self.as_of)
        self.assertAlmostEqual(avg, 500_000)

    def test_skips_periods_with_no_essential_spending(self):
        # 2026-06 has no essential spending at all -> should be skipped, not counted as 0.
        insert_tx(self.conn, "2026-05-20 10:00:00", 1_000_000, "out", category_id=1)
        insert_tx(self.conn, "2026-04-20 10:00:00", 800_000, "out", category_id=1)
        self.conn.commit()
        avg = risk.get_average_period_essential_expense(self.cursor, periods=2, as_of=self.as_of)
        self.assertAlmostEqual(avg, (1_000_000 + 800_000) / 2)  # not diluted by an assumed 0 in June

    def test_returns_none_with_no_data(self):
        avg = risk.get_average_period_essential_expense(self.cursor, periods=3, as_of=self.as_of)
        self.assertIsNone(avg)

    def test_optional_category_not_counted(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 900_000, "out", category_id=1)  # essential
        insert_tx(self.conn, "2026-06-21 10:00:00", 2_000_000, "out", category_id=2)  # optional, must be ignored
        self.conn.commit()
        avg = risk.get_average_period_essential_expense(self.cursor, periods=1, as_of=self.as_of)
        self.assertAlmostEqual(avg, 900_000)


class BudgetBalance503020Tests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()

    def test_period_scoped_correctly(self):
        # period_id "2026-07" == 2026-07-15 .. 2026-08-14
        insert_tx(self.conn, "2026-07-20 10:00:00", 1_000_000, "out", category_id=1)  # essential, in period
        insert_tx(self.conn, "2026-07-25 10:00:00", 500_000, "out", category_id=2)    # optional, in period
        insert_tx(self.conn, "2026-08-01 10:00:00", 3_000_000, "in", category_id=3)   # income, in period
        insert_tx(self.conn, "2026-07-10 10:00:00", 9_999_999, "out", category_id=1)  # PREVIOUS period, must be excluded
        insert_tx(self.conn, "2026-08-15 10:00:00", 9_999_999, "out", category_id=1)  # NEXT period, must be excluded
        self.conn.commit()

        result = risk.budget_balance_50_30_20(self.cursor, "2026-07")
        self.assertEqual(result["essential"], 1_000_000)
        self.assertEqual(result["optional"], 500_000)
        self.assertEqual(result["income"], 3_000_000)
        self.assertEqual(result["savings"], 3_000_000 - 1_000_000 - 500_000)
        self.assertAlmostEqual(result["essential_pct"], 1_000_000 / 3_000_000 * 100)

    def test_zero_income_gives_none_percentages(self):
        insert_tx(self.conn, "2026-07-20 10:00:00", 100_000, "out", category_id=1)
        self.conn.commit()
        result = risk.budget_balance_50_30_20(self.cursor, "2026-07")
        self.assertIsNone(result["essential_pct"])
        self.assertEqual(result["income"], 0)


class SavingsRateTrendTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_trend_direction_and_exclusion_of_current_period(self):
        # period 2026-05: income 1,000,000 expense 800,000 -> 20%
        insert_tx(self.conn, "2026-05-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-05-21 10:00:00", 800_000, "out", category_id=1)
        # period 2026-06: income 1,000,000 expense 500,000 -> 50%
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-06-21 10:00:00", 500_000, "out", category_id=1)
        # current period 2026-07 (must be excluded even with a huge number)
        insert_tx(self.conn, "2026-07-16 10:00:00", 999_999_999, "in", category_id=3)
        self.conn.commit()

        trend = risk.get_savings_rate_trend(self.cursor, periods=6, as_of=self.as_of)
        period_ids = [p["period_id"] for p in trend["periods"]]
        self.assertEqual(period_ids, ["2026-05", "2026-06"])
        self.assertAlmostEqual(trend["periods"][0]["savings_rate"], 20.0)
        self.assertAlmostEqual(trend["periods"][1]["savings_rate"], 50.0)
        self.assertEqual(trend["trend"], "improving")

    def test_declining_trend(self):
        insert_tx(self.conn, "2026-05-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-05-21 10:00:00", 200_000, "out", category_id=1)  # 80%
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-06-21 10:00:00", 900_000, "out", category_id=1)  # 10%
        self.conn.commit()
        trend = risk.get_savings_rate_trend(self.cursor, periods=6, as_of=self.as_of)
        self.assertEqual(trend["trend"], "declining")

    def test_no_data_gives_empty_trend(self):
        trend = risk.get_savings_rate_trend(self.cursor, periods=6, as_of=self.as_of)
        self.assertEqual(trend["periods"], [])
        self.assertIsNone(trend["trend"])


class ShortTermForecastTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()

    def test_days_remaining_matches_period_not_calendar_month(self):
        # as_of = 2026-07-20, period 2026-07-15..2026-08-14 -> period_end - as_of = 25 days remaining
        forecast = risk.short_term_forecast(self.cursor, as_of=date(2026, 7, 20))
        self.assertEqual(forecast["days_remaining"], 25)

    def test_last_day_of_period_has_zero_days_remaining(self):
        forecast = risk.short_term_forecast(self.cursor, as_of=date(2026, 8, 14))
        self.assertEqual(forecast["days_remaining"], 0)

    def test_at_risk_flag_when_forecast_negative(self):
        # liquid balance 5,000,000 (seeded), add a huge recurring due later this period
        self.conn.execute(
            """INSERT INTO recurring (name, amount, direction, account_id, frequency, day_of_period, next_due, is_active)
               VALUES ('Big rent', 10000000, 'out', 1, 'monthly', 20, '2026-07-25', 1)"""
        )
        self.conn.commit()
        forecast = risk.short_term_forecast(self.cursor, as_of=date(2026, 7, 20))
        self.assertTrue(forecast["at_risk"])
        self.assertEqual(forecast["remaining_recurring"], 10_000_000)


class WrapperMetricsStillWorkTests(unittest.TestCase):
    """liquidity_risk / runway_months / income_sustainability_margin are thin
    wrappers around get_average_period_essential_expense — confirm their
    has_data/None handling still works correctly after the retrofit."""

    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_no_data_yields_none_not_crash(self):
        liquidity = risk.liquidity_risk(self.cursor)
        self.assertIsNone(liquidity["sufficient"])
        runway = risk.runway_months(self.cursor)
        self.assertIsNone(runway["months"])
        self.assertIsNone(runway["level"])

    def test_with_data_liquidity_and_runway_are_consistent(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "out", category_id=1)
        self.conn.commit()
        liquidity = risk.liquidity_risk(self.cursor)
        self.assertEqual(liquidity["essential_monthly_expense"], 1_000_000)
        self.assertTrue(liquidity["sufficient"])  # 5,000,000 liquid >= 1,000,000
        runway = risk.runway_months(self.cursor)
        self.assertAlmostEqual(runway["months"], 5.0)  # 5,000,000 / 1,000,000
        self.assertEqual(runway["level"], "on")  # band: 3 <= 5.0 < 6 -> "on"


class OldBudgetStatusUnaffectedTests(unittest.TestCase):
    """get_budget_status (the OLD, orphaned calendar-month system) must be
    completely untouched by this retrofit — it still reads real calendar
    months, not periods, on purpose (see risk.py's own docstring)."""

    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.conn.execute(
            "INSERT INTO budgets (category_id, monthly_limit, is_active) VALUES (1, 1000000, 1)"
        )
        self.conn.commit()

    def test_still_calendar_month_scoped(self):
        insert_tx(self.conn, "2026-07-05 10:00:00", 400_000, "out", category_id=1)  # calendar July
        insert_tx(self.conn, "2026-06-25 10:00:00", 999_999, "out", category_id=1)  # calendar June, must be excluded
        self.conn.commit()
        statuses = risk.get_budget_status(self.cursor, "2026-07")
        self.assertEqual(len(statuses), 1)
        self.assertEqual(statuses[0]["spent"], 400_000)


class GoalProgressTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.conn.execute(
            "UPDATE accounts SET current_balance = 3000000 WHERE id = 1"
        )
        self.conn.commit()

    def _make_goal(self, target_amount, deadline, created_at):
        self.cursor.execute(
            """INSERT INTO goals (name, goal_type, target_amount, deadline, account_id, created_at)
               VALUES ('Test goal', 'savings', ?, ?, 1, ?)""",
            (target_amount, deadline, created_at),
        )
        self.conn.commit()
        return transaction_get_goal(self.cursor, self.cursor.lastrowid)

    def test_progress_pct_and_remaining(self):
        goal = self._make_goal(10_000_000, "2027-01-15", "2026-07-15 00:00:00")
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 20))
        self.assertAlmostEqual(progress["progress_pct"], 30.0)  # 3M / 10M
        self.assertEqual(progress["remaining_amount"], 7_000_000)

    def test_periods_remaining_and_required_per_period(self):
        # created 2026-07-15, deadline 2027-01-15 (period id 2027-01), as_of 2026-07-20 (period 2026-07)
        # periods_between(2026-07, 2027-01) = 6, +1 inclusive = 7 periods remaining
        goal = self._make_goal(10_000_000, "2027-01-15", "2026-07-15 00:00:00")
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 20))
        self.assertEqual(progress["periods_remaining"], 7)
        self.assertEqual(progress["required_per_period"], round(7_000_000 / 7))

    def test_progress_capped_at_100_when_over_target(self):
        goal = self._make_goal(1_000_000, "2027-01-15", "2026-07-15 00:00:00")  # target well under current balance
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 20))
        self.assertEqual(progress["progress_pct"], 100)
        self.assertEqual(progress["remaining_amount"], 0)

    def test_off_track_when_behind_linear_schedule(self):
        # created a year before deadline, now halfway through the timeline but progress is only 30%
        goal = self._make_goal(10_000_000, "2027-01-15", "2026-01-15 00:00:00")
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 15))
        self.assertGreater(progress["expected_pct"], 30.0 + 5)
        self.assertTrue(progress["is_off_track"])

    def test_not_off_track_when_ahead_of_schedule(self):
        goal = self._make_goal(3_100_000, "2027-06-15", "2026-07-01 00:00:00")
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 20))
        self.assertFalse(progress["is_off_track"])

    def test_overdue_flag(self):
        goal = self._make_goal(10_000_000, "2026-01-15", "2025-01-15 00:00:00")
        progress = risk.get_goal_progress(self.cursor, goal, as_of=date(2026, 7, 20))
        self.assertTrue(progress["is_overdue"])
        self.assertFalse(progress["is_off_track"])  # overdue takes precedence, not double-flagged


class EmergencyFundSuggestionTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()

    def test_none_with_no_data(self):
        self.assertIsNone(risk.suggest_emergency_fund_target(self.cursor))

    def test_six_times_average_essential_expense(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "out", category_id=1)
        self.conn.commit()
        target = risk.suggest_emergency_fund_target(self.cursor)
        self.assertEqual(target, 6_000_000)


class SpendingSimulationTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.conn.execute("UPDATE accounts SET current_balance = 10_000_000 WHERE id = 1")
        # 3 completed periods of history: income 2,000,000, expense 1,000,000 each
        for occurred_at in ["2026-04-20 10:00:00", "2026-05-20 10:00:00", "2026-06-20 10:00:00"]:
            insert_tx(self.conn, occurred_at, 2_000_000, "in", category_id=3)
            insert_tx(self.conn, occurred_at, 1_000_000, "out", category_id=1)
        self.conn.commit()

    def test_baseline_flow_averages_history(self):
        flow = risk.get_baseline_period_flow(self.cursor, periods=3)
        self.assertAlmostEqual(flow["avg_income"], 2_000_000)
        self.assertAlmostEqual(flow["avg_expense"], 1_000_000)

    def test_baseline_flow_empty_with_no_history(self):
        empty_cursor = build_test_db().cursor()
        flow = risk.get_baseline_period_flow(empty_cursor, periods=3)
        self.assertEqual(flow, {"avg_income": 0, "avg_expense": 0})

    def test_trajectory_continues_average_flow(self):
        trajectory = risk.project_simple_trajectory(self.cursor, 3)
        # each period: +2,000,000 income -1,000,000 expense = +1,000,000 net
        self.assertEqual(trajectory, [11_000_000, 12_000_000, 13_000_000])

    def test_trajectory_applies_extra_expenses_at_right_offsets(self):
        trajectory = risk.project_simple_trajectory(self.cursor, 3, extra_expenses={0: 5_000_000, 2: 1_000_000})
        self.assertEqual(trajectory, [6_000_000, 7_000_000, 7_000_000])

    def test_traffic_light_green_when_comfortably_positive(self):
        trajectory = [20_000_000, 21_000_000]
        self.assertEqual(risk.traffic_light_for_trajectory(self.cursor, trajectory), "green")

    def test_traffic_light_yellow_when_below_essential_but_positive(self):
        # essential expense per period ~1,000,000 (from history); dip below that but stay positive
        trajectory = [500_000, 2_000_000]
        self.assertEqual(risk.traffic_light_for_trajectory(self.cursor, trajectory), "yellow")

    def test_traffic_light_red_when_negative(self):
        trajectory = [500_000, -100_000]
        self.assertEqual(risk.traffic_light_for_trajectory(self.cursor, trajectory), "red")

    def test_compute_spending_scenarios_shape_and_tco(self):
        scenarios, baseline = risk.compute_spending_scenarios(
            self.cursor, item_amount=6_000_000, maintenance_cost_per_period=100_000, expected_lifetime_periods=12
        )
        # 1 pay_now + 3 installment options + 2 delay options = 6 scenarios
        self.assertEqual(len(scenarios), 6)
        expected_tco = 6_000_000 + 100_000 * 12
        for s in scenarios:
            self.assertEqual(s["total_cost_of_ownership"], expected_tco)
            self.assertEqual(len(s["projected_balances"]), risk.SIMULATION_TRAJECTORY_PERIODS)
        self.assertEqual(len(baseline), risk.SIMULATION_TRAJECTORY_PERIODS)

    def test_pay_now_deducts_full_amount_immediately(self):
        scenarios, baseline = risk.compute_spending_scenarios(self.cursor, item_amount=6_000_000)
        pay_now = next(s for s in scenarios if s["scenario_type"] == "pay_now")
        # period 0: 10M + 1M net flow - 6M item = 5M
        self.assertEqual(pay_now["projected_balances"][0], 5_000_000)
        # baseline period 0 (no expense) should be higher
        self.assertGreater(baseline[0], pay_now["projected_balances"][0])

    def test_installments_spread_cost_evenly(self):
        scenarios, _ = risk.compute_spending_scenarios(self.cursor, item_amount=6_000_000)
        inst3 = next(s for s in scenarios if s["scenario_type"] == "installments" and s["installment_periods"] == 3)
        # each of first 3 periods pays 2,000,000 extra: net flow +1M - 2M = -1M/period
        self.assertEqual(inst3["projected_balances"][0], 9_000_000)
        self.assertEqual(inst3["projected_balances"][1], 8_000_000)
        self.assertEqual(inst3["projected_balances"][2], 7_000_000)
        # 4th period: no more installment, just +1M net
        self.assertEqual(inst3["projected_balances"][3], 8_000_000)

    def test_delay_pushes_full_cost_to_future_period(self):
        scenarios, baseline = risk.compute_spending_scenarios(self.cursor, item_amount=6_000_000)
        delay3 = next(s for s in scenarios if s["scenario_type"] == "delay" and s["delay_periods"] == 3)
        # periods 0-2: no expense yet, same as baseline
        self.assertEqual(delay3["projected_balances"][:3], baseline[:3])
        # period 3: baseline + 1M net - 6M item
        self.assertEqual(delay3["projected_balances"][3], baseline[3] - 6_000_000)


def transaction_get_goal(cursor, goal_id):
    """Mirrors transaction.get_goal_by_id's SELECT — duplicated here (not
    imported) so this test file has no dependency on transaction.py, matching
    the rest of this file's pattern of building its own minimal test rows."""
    cursor.execute(
        """SELECT g.id, g.name, g.goal_type, g.target_amount, g.deadline, g.account_id, g.created_at,
                  a.name AS account_name, a.current_balance
           FROM goals g JOIN accounts a ON g.account_id = a.id
           WHERE g.id = ?""",
        (goal_id,),
    )
    return cursor.fetchone()


if __name__ == "__main__":
    unittest.main()
