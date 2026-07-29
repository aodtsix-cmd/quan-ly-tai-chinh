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
                      "004_goals.sql", "005_simulations.sql", "006_cashflow_forecast.sql",
                      "007_investment_stub.sql"]:
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


class RecurringProjectionTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()

    def _add_recurring(self, amount, direction, frequency, next_due):
        self.conn.execute(
            """INSERT INTO recurring (name, amount, direction, account_id, frequency, day_of_period, next_due, is_active)
               VALUES ('Test', ?, ?, 1, ?, 1, ?, 1)""",
            (amount, direction, frequency, next_due),
        )
        self.conn.commit()

    def test_monthly_recurring_hits_every_period(self):
        self._add_recurring(500_000, "out", "monthly", "2026-07-20")
        totals = risk.project_recurring_by_period(self.cursor, ["2026-07", "2026-08", "2026-09"])
        self.assertEqual(totals["2026-07"]["out"], 500_000)
        self.assertEqual(totals["2026-08"]["out"], 500_000)
        self.assertEqual(totals["2026-09"]["out"], 500_000)

    def test_quarterly_recurring_skips_intermediate_periods(self):
        self._add_recurring(900_000, "out", "quarterly", "2026-07-20")
        totals = risk.project_recurring_by_period(self.cursor, ["2026-07", "2026-08", "2026-09"])
        self.assertEqual(totals["2026-07"]["out"], 900_000)
        self.assertEqual(totals["2026-08"]["out"], 0)
        self.assertEqual(totals["2026-09"]["out"], 0)

    def test_income_direction_counted_separately_from_expense(self):
        self._add_recurring(2_000_000, "in", "monthly", "2026-07-20")
        totals = risk.project_recurring_by_period(self.cursor, ["2026-07"])
        self.assertEqual(totals["2026-07"]["in"], 2_000_000)
        self.assertEqual(totals["2026-07"]["out"], 0)

    def test_yearly_recurring_only_hits_matching_period(self):
        self._add_recurring(12_000_000, "out", "yearly", "2026-07-20")
        totals = risk.project_recurring_by_period(self.cursor, ["2026-07", "2026-08", "2027-06", "2027-07"])
        self.assertEqual(totals["2026-07"]["out"], 12_000_000)
        self.assertEqual(totals["2026-08"]["out"], 0)
        self.assertEqual(totals["2027-06"]["out"], 0)
        self.assertEqual(totals["2027-07"]["out"], 12_000_000)


class SeasonalityDetectionTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2027, 7, 20)

    def _seed_monthly_expense(self, year, month, amount):
        insert_tx(self.conn, f"{year:04d}-{month:02d}-20 10:00:00", amount, "out", category_id=1)

    def test_not_enough_data_below_threshold(self):
        self._seed_monthly_expense(2026, 6, 1_000_000)
        self.conn.commit()
        result = risk.detect_seasonality(self.cursor, as_of=self.as_of)
        self.assertFalse(result["has_enough_data"])

    def test_detects_notably_high_month_and_ignores_normal_months(self):
        # 2025-08 through 2027-06 = 23 completed periods; December double the rest
        for year, month in [(2025, m) for m in range(8, 13)] + \
                            [(2026, m) for m in range(1, 13)] + \
                            [(2027, m) for m in range(1, 7)]:
            amount = 2_000_000 if month == 12 else 1_000_000
            self._seed_monthly_expense(year, month, amount)
        self.conn.commit()

        result = risk.detect_seasonality(self.cursor, as_of=self.as_of)
        self.assertTrue(result["has_enough_data"])
        self.assertEqual(result["periods_analyzed"], 23)

        months_flagged = {p["month"] for p in result["patterns"]}
        self.assertIn(12, months_flagged)
        self.assertNotIn(1, months_flagged)  # normal month, within threshold, must not be flagged

        december = next(p for p in result["patterns"] if p["month"] == 12)
        self.assertGreater(december["pct_difference"], risk.SEASONALITY_PCT_THRESHOLD)
        self.assertEqual(december["sample_count"], 2)

    def test_current_open_period_excluded(self):
        for year, month in [(2025, m) for m in range(8, 13)] + \
                            [(2026, m) for m in range(1, 13)] + \
                            [(2027, m) for m in range(1, 7)]:
            self._seed_monthly_expense(year, month, 1_000_000)
        # huge expense in the still-open current period -> must not affect the analysis
        self._seed_monthly_expense(2027, 7, 999_999_999)
        self.conn.commit()
        result = risk.detect_seasonality(self.cursor, as_of=self.as_of)
        self.assertEqual(result["periods_analyzed"], 23)


class CashflowForecastTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.conn.execute("UPDATE accounts SET current_balance = 10_000_000 WHERE id = 1")
        for occurred_at in ["2026-04-20 10:00:00", "2026-05-20 10:00:00", "2026-06-20 10:00:00"]:
            insert_tx(self.conn, occurred_at, 2_000_000, "in", category_id=3)
            insert_tx(self.conn, occurred_at, 1_000_000, "out", category_id=1)
        self.conn.commit()
        self.as_of = date(2026, 7, 20)

    def test_basic_forecast_no_recurring_no_goals(self):
        results = risk.compute_cashflow_forecast(self.cursor, 3, as_of=self.as_of)
        self.assertEqual(len(results), 3)
        self.assertEqual(results[0]["projected_balance"], 9_000_000)
        self.assertEqual(results[1]["projected_balance"], 8_000_000)
        self.assertEqual(results[2]["projected_balance"], 7_000_000)
        self.assertEqual([r["period_id"] for r in results], ["2026-07", "2026-08", "2026-09"])

    def test_recurring_does_not_get_double_counted_against_baseline(self):
        self.conn.execute(
            """INSERT INTO recurring (name, amount, direction, account_id, frequency, day_of_period, next_due, is_active)
               VALUES ('Rent', 500000, 'out', 1, 'monthly', 1, '2026-07-20', 1)"""
        )
        self.conn.commit()
        results = risk.compute_cashflow_forecast(self.cursor, 1, as_of=self.as_of)
        # avg_recurring_out=500k -> other_variable = max(1,000,000-500,000,0)=500k
        # total expense = 500k (recurring) + 500k (other variable) = 1,000,000, same as baseline total
        self.assertEqual(results[0]["projected_expense"], 1_000_000)

    def test_reliable_income_applied_every_period(self):
        self.conn.execute(
            "INSERT INTO income_sources (name, type, expected_amount, reliability, is_active) VALUES ('Job', 'fixed', 3000000, 100, 1)"
        )
        self.conn.commit()
        results = risk.compute_cashflow_forecast(self.cursor, 2, as_of=self.as_of)
        self.assertEqual(results[0]["projected_income"], 3_000_000)
        self.assertEqual(results[1]["projected_income"], 3_000_000)

    def test_irregular_income_applied_at_right_offset(self):
        results = risk.compute_cashflow_forecast(
            self.cursor, 3, irregular_income_by_offset={1: 5_000_000}, as_of=self.as_of
        )
        self.assertEqual(results[0]["projected_income"], 0)
        self.assertEqual(results[1]["projected_income"], 5_000_000)
        self.assertEqual(results[2]["projected_income"], 0)

    def test_goal_contribution_reduces_balance_every_period(self):
        results = risk.compute_cashflow_forecast(
            self.cursor, 2, goal_contribution_per_period=200_000, as_of=self.as_of
        )
        self.assertEqual(results[0]["projected_expense"], 1_200_000)
        self.assertEqual(results[0]["projected_balance"], 10_000_000 - 1_200_000)

    def test_is_danger_flags_low_balance(self):
        self.conn.execute("UPDATE accounts SET current_balance = 500000 WHERE id = 1")
        self.conn.commit()
        results = risk.compute_cashflow_forecast(self.cursor, 2, as_of=self.as_of)
        self.assertTrue(results[0]["is_danger"])

    def test_seasonality_pattern_scales_matching_month(self):
        pattern = [{"month": 7, "avg_expense": 2_000_000, "overall_avg": 1_000_000,
                    "pct_difference": 100.0, "stdev": 0, "sample_count": 2}]
        results = risk.compute_cashflow_forecast(self.cursor, 1, seasonality_patterns=pattern, as_of=self.as_of)
        self.assertEqual(results[0]["projected_expense"], 2_000_000)


class NetWorthTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()

    def test_sums_accounts_and_investments(self):
        self.conn.execute(
            "INSERT INTO investment_assets (name, asset_type, current_value, is_active) VALUES ('Vang', 'gold', 2000000, 1)"
        )
        self.conn.commit()
        self.assertEqual(risk.get_total_net_worth(self.cursor), 5_000_000 + 2_000_000)

    def test_inactive_investment_excluded(self):
        self.conn.execute(
            "INSERT INTO investment_assets (name, asset_type, current_value, is_active) VALUES ('Old', 'stock', 9999999, 0)"
        )
        self.conn.commit()
        self.assertEqual(risk.get_total_net_worth(self.cursor), 5_000_000)

    def test_zero_when_no_investments(self):
        self.assertEqual(risk.get_total_net_worth(self.cursor), 5_000_000)


class DailySpendAndSurvivalTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_average_daily_total_spend_includes_all_out(self):
        insert_tx(self.conn, "2026-07-10 10:00:00", 1_500_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-15 10:00:00", 1_500_000, "out", category_id=2, source="recurring")
        self.conn.commit()
        # (1.5M + 1.5M) / 30 days = 100,000/day -- recurring is NOT excluded here (unlike the variable-spend function)
        self.assertAlmostEqual(risk.get_average_daily_total_spend(self.cursor, as_of=self.as_of), 100_000)

    def test_survival_days(self):
        insert_tx(self.conn, "2026-07-10 10:00:00", 3_000_000, "out", category_id=1)
        self.conn.commit()
        # daily spend = 3,000,000/30 = 100,000; liquid balance = 5,000,000 -> 50 days
        self.assertAlmostEqual(risk.get_survival_days(self.cursor, as_of=self.as_of), 50)

    def test_survival_days_none_with_no_spend(self):
        self.assertIsNone(risk.get_survival_days(self.cursor, as_of=self.as_of))


class FinancialRigidityTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.conn.execute(
            "INSERT INTO categories (id, name_vi, name_en, kind, stability) VALUES (4, 'Tien nha', 'Rent', 'expense', 'fixed')"
        )
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_ratio_of_fixed_expense_to_income(self):
        for occurred_at in ["2026-04-20 10:00:00", "2026-05-20 10:00:00", "2026-06-20 10:00:00"]:
            insert_tx(self.conn, occurred_at, 2_000_000, "in", category_id=3)
            insert_tx(self.conn, occurred_at, 500_000, "out", category_id=4)  # fixed
            insert_tx(self.conn, occurred_at, 300_000, "out", category_id=1)  # not fixed, must be excluded
        self.conn.commit()
        rigidity = risk.get_financial_rigidity(self.cursor, periods=3, as_of=self.as_of)
        self.assertAlmostEqual(rigidity, 500_000 * 3 / (2_000_000 * 3) * 100)

    def test_none_with_no_income(self):
        self.assertIsNone(risk.get_financial_rigidity(self.cursor, as_of=self.as_of))


class BurnRateTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)  # current period 2026-07-15..2026-08-14 (31 days, day 6 elapsed)

    def test_no_data_without_budgets(self):
        result = risk.get_burn_rate_vs_elapsed(self.cursor, as_of=self.as_of)
        self.assertFalse(result["has_data"])

    def test_ratio_above_one_when_spending_ahead_of_pace(self):
        self.conn.execute(
            "INSERT INTO period_budgets (category_id, period_id, amount, source) VALUES (1, '2026-07', 1000000, 'manual')"
        )
        insert_tx(self.conn, "2026-07-17 10:00:00", 400_000, "out", category_id=1)
        self.conn.commit()
        result = risk.get_burn_rate_vs_elapsed(self.cursor, as_of=self.as_of)
        self.assertTrue(result["has_data"])
        self.assertAlmostEqual(result["pct_used"], 40.0)
        self.assertAlmostEqual(result["pct_elapsed"], 6 / 31 * 100)
        self.assertGreater(result["ratio"], 1)


class CurrentPeriodSavingsRateTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_rate_within_elapsed_part_of_period(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-07-17 10:00:00", 400_000, "out", category_id=1)
        self.conn.commit()
        rate = risk.get_current_period_savings_rate(self.cursor, as_of=self.as_of)
        self.assertAlmostEqual(rate, 60.0)

    def test_excludes_transactions_after_as_of(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-07-25 10:00:00", 999_999_999, "out", category_id=1)  # after as_of
        self.conn.commit()
        rate = risk.get_current_period_savings_rate(self.cursor, as_of=self.as_of)
        self.assertAlmostEqual(rate, 100.0)

    def test_none_with_no_income_yet(self):
        self.assertIsNone(risk.get_current_period_savings_rate(self.cursor, as_of=self.as_of))


class SpendingConcentrationTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.conn.execute(
            "INSERT INTO categories (id, name_vi, name_en, kind, necessity, parent_id) VALUES (5, 'Con', 'Child', 'expense', 'essential', 1)"
        )
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_identifies_top_category_by_percentage(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 600_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-17 10:00:00", 400_000, "out", category_id=2)
        self.conn.commit()
        result = risk.get_spending_concentration(self.cursor, as_of=self.as_of)
        self.assertEqual(result["category_name"], "Thiết yếu")
        self.assertAlmostEqual(result["pct_of_total"], 60.0)

    def test_child_category_rolls_up_to_parent(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 700_000, "out", category_id=5)  # child of category 1
        insert_tx(self.conn, "2026-07-17 10:00:00", 300_000, "out", category_id=2)
        self.conn.commit()
        result = risk.get_spending_concentration(self.cursor, as_of=self.as_of)
        self.assertEqual(result["category_name"], "Thiết yếu")  # parent's name, not the child's
        self.assertAlmostEqual(result["pct_of_total"], 70.0)

    def test_none_with_no_expense(self):
        self.assertIsNone(risk.get_spending_concentration(self.cursor, as_of=self.as_of))


class IncomeStabilityTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_zero_when_perfectly_stable(self):
        for occurred_at in ["2026-04-20 10:00:00", "2026-05-20 10:00:00", "2026-06-20 10:00:00"]:
            insert_tx(self.conn, occurred_at, 1_000_000, "in", category_id=3)
        self.conn.commit()
        self.assertAlmostEqual(risk.get_income_stability(self.cursor, as_of=self.as_of), 0.0)

    def test_coefficient_of_variation_with_varying_income(self):
        for occurred_at, amount in zip(
            ["2026-04-20 10:00:00", "2026-05-20 10:00:00", "2026-06-20 10:00:00"],
            [800_000, 1_000_000, 1_200_000],
        ):
            insert_tx(self.conn, occurred_at, amount, "in", category_id=3)
        self.conn.commit()
        self.assertAlmostEqual(risk.get_income_stability(self.cursor, as_of=self.as_of), 20.0)

    def test_none_with_fewer_than_two_income_periods(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "in", category_id=3)
        self.conn.commit()
        self.assertIsNone(risk.get_income_stability(self.cursor, as_of=self.as_of))


class BudgetStreakTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def _set_budget_and_spend(self, period_id, budget, spent):
        self.conn.execute(
            "INSERT INTO period_budgets (category_id, period_id, amount, source) VALUES (1, ?, ?, 'manual')",
            (period_id, budget),
        )
        period_start, _ = period.period_bounds_for_id(period_id, 15)
        insert_tx(self.conn, f"{period_start.isoformat()} 10:00:00", spent, "out", category_id=1)

    def test_no_data_without_any_budget(self):
        result = risk.get_budget_streak(self.cursor, as_of=self.as_of)
        self.assertFalse(result["has_data"])

    def test_streak_stops_at_first_over_budget_period(self):
        self._set_budget_and_spend("2026-06", 1_000_000, 500_000)   # under, most recent completed
        self._set_budget_and_spend("2026-05", 1_000_000, 500_000)   # under
        self._set_budget_and_spend("2026-04", 1_000_000, 1_500_000)  # over -> streak stops here
        self.conn.commit()
        result = risk.get_budget_streak(self.cursor, as_of=self.as_of)
        self.assertTrue(result["has_data"])
        self.assertEqual(result["streak"], 2)


class HealthScoreTests(unittest.TestCase):
    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_none_without_essential_history(self):
        result = risk.get_health_score(self.cursor, as_of=self.as_of)
        self.assertIsNone(result["level"])
        self.assertFalse(result["has_data"])

    def test_matches_runway_level_when_nothing_else_is_wrong(self):
        # Only one completed period (2026-06) has essential spending, so that
        # 1,000,000 IS the average (zero-spend periods are skipped, not
        # counted as 0 -- see get_average_period_essential_expense). Runway =
        # 4,000,000 / 1,000,000 = 4 months -> "on" (band: 3 <= x < 6).
        self.conn.execute("UPDATE accounts SET current_balance = 4_000_000 WHERE id = 1")
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "out", category_id=1)
        self.conn.commit()
        runway = risk.runway_months(self.cursor)
        self.assertEqual(runway["level"], "on")
        result = risk.get_health_score(self.cursor, as_of=self.as_of)
        self.assertEqual(result["level"], runway["level"])
        self.assertEqual(result["downgraded_reasons"], [])

    def test_downgrades_on_short_term_forecast_risk(self):
        # liquid balance high enough for a decent runway, but a huge recurring bill
        # due later this period makes the immediate short-term forecast go negative
        self.conn.execute("UPDATE accounts SET current_balance = 10_000_000 WHERE id = 1")
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "out", category_id=1)
        self.conn.execute(
            """INSERT INTO recurring (name, amount, direction, account_id, frequency, day_of_period, next_due, is_active)
               VALUES ('Big bill', 50000000, 'out', 1, 'monthly', 1, '2026-07-25', 1)"""
        )
        self.conn.commit()
        forecast = risk.short_term_forecast(self.cursor, as_of=self.as_of)
        self.assertTrue(forecast["at_risk"])
        runway = risk.runway_months(self.cursor)
        result = risk.get_health_score(self.cursor, as_of=self.as_of)
        self.assertLess(
            risk.HEALTH_LEVELS.index(result["level"]),
            risk.HEALTH_LEVELS.index(runway["level"]),
        )
        self.assertIn("Dự báo cuối kỳ có thể âm quỹ", result["downgraded_reasons"])

    def test_never_downgrades_below_worst_level(self):
        self.conn.execute("UPDATE accounts SET current_balance = 100_000 WHERE id = 1")
        insert_tx(self.conn, "2026-06-20 10:00:00", 5_000_000, "out", category_id=1)
        self.conn.execute(
            """INSERT INTO recurring (name, amount, direction, account_id, frequency, day_of_period, next_due, is_active)
               VALUES ('Big bill', 50000000, 'out', 1, 'monthly', 1, '2026-07-25', 1)"""
        )
        self.conn.commit()
        runway = risk.runway_months(self.cursor)
        self.assertEqual(runway["level"], "nguy_hiem")
        result = risk.get_health_score(self.cursor, as_of=self.as_of)
        self.assertEqual(result["level"], "nguy_hiem")  # can't go any lower than this


class TransferExclusionTests(unittest.TestCase):
    """A transaction tagged with a categories.kind='transfer' category (see
    transaction.insert_transfer) is money moved between the user's OWN
    accounts -- not real income or expense. Every risk.py aggregate that
    sums 'in'/'out' transactions without already filtering on something
    else (necessity, parent rollup) must exclude it, confirmed by seeding a
    large transfer alongside small real income/expense and checking the
    transfer's amount never leaks into the result."""

    def setUp(self):
        self.conn = build_test_db()
        seed_account_and_categories(self.conn)
        self.conn.execute(
            "INSERT INTO categories (id, name_vi, name_en, kind, stability) VALUES (4, 'Chuyen khoan', 'Transfer', 'transfer', 'variable')"
        )
        self.cursor = self.conn.cursor()
        self.as_of = date(2026, 7, 20)

    def test_savings_rate_trend_ignores_transfer(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-06-21 10:00:00", 500_000, "out", category_id=1)
        # A transfer dwarfing the real income/expense above -- if it leaked
        # in, the savings rate here would be wildly different from 50%.
        insert_tx(self.conn, "2026-06-22 10:00:00", 50_000_000, "out", category_id=4)
        insert_tx(self.conn, "2026-06-22 10:00:00", 50_000_000, "in", category_id=4)
        self.conn.commit()
        trend = risk.get_savings_rate_trend(self.cursor, periods=3, as_of=self.as_of)
        self.assertEqual(len(trend["periods"]), 1)
        self.assertEqual(trend["periods"][0]["income"], 1_000_000)
        self.assertEqual(trend["periods"][0]["expense"], 500_000)
        self.assertAlmostEqual(trend["periods"][0]["savings_rate"], 50.0)

    def test_current_period_savings_rate_ignores_transfer(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-07-17 10:00:00", 400_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-17 10:00:00", 20_000_000, "out", category_id=4)
        insert_tx(self.conn, "2026-07-17 10:00:00", 20_000_000, "in", category_id=4)
        self.conn.commit()
        rate = risk.get_current_period_savings_rate(self.cursor, as_of=self.as_of)
        self.assertAlmostEqual(rate, 60.0)

    def test_budget_balance_50_30_20_ignores_transfer_income(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-07-17 10:00:00", 20_000_000, "in", category_id=4)
        self.conn.commit()
        result = risk.budget_balance_50_30_20(self.cursor, "2026-07")
        self.assertEqual(result["income"], 1_000_000)

    def test_average_daily_variable_spend_ignores_transfer(self):
        insert_tx(self.conn, "2026-07-10 10:00:00", 300_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-11 10:00:00", 10_000_000, "out", category_id=4)
        self.conn.commit()
        avg = risk.get_average_daily_variable_spend(self.cursor, as_of=date(2026, 7, 20))
        self.assertAlmostEqual(avg, 300_000 / 30)

    def test_average_daily_total_spend_ignores_transfer(self):
        insert_tx(self.conn, "2026-07-10 10:00:00", 300_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-11 10:00:00", 10_000_000, "out", category_id=4)
        self.conn.commit()
        avg = risk.get_average_daily_total_spend(self.cursor, as_of=date(2026, 7, 20))
        self.assertAlmostEqual(avg, 300_000 / 30)

    def test_spending_concentration_ignores_transfer(self):
        insert_tx(self.conn, "2026-07-16 10:00:00", 100_000, "out", category_id=1)
        insert_tx(self.conn, "2026-07-17 10:00:00", 10_000_000, "out", category_id=4)
        self.conn.commit()
        result = risk.get_spending_concentration(self.cursor, as_of=self.as_of)
        self.assertEqual(result["amount"], 100_000)
        self.assertAlmostEqual(result["pct_of_total"], 100.0)

    def test_financial_rigidity_ignores_transfer_income(self):
        insert_tx(self.conn, "2026-06-20 10:00:00", 1_000_000, "in", category_id=3)
        insert_tx(self.conn, "2026-06-20 10:00:00", 20_000_000, "in", category_id=4)
        self.conn.commit()
        # No fixed-stability category exists in this fixture, so total_fixed
        # is 0 regardless -- this test only checks total_income (the
        # denominator) isn't inflated by the transfer's 'in' leg.
        rigidity = risk.get_financial_rigidity(self.cursor, periods=1, as_of=self.as_of)
        self.assertAlmostEqual(rigidity, 0.0)

    def test_detect_seasonality_ignores_transfer(self):
        # A single huge transfer, with no other expense history at all,
        # must not itself be enough to register as a period of "out" spend.
        insert_tx(self.conn, "2026-06-20 10:00:00", 10_000_000, "out", category_id=4)
        self.conn.commit()
        result = risk.detect_seasonality(self.cursor, as_of=self.as_of)
        self.assertEqual(result["periods_analyzed"], 0)


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
