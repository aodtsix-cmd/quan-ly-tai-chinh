"""Tests for transaction.parse_amount_vnd — the Vietnamese-shorthand-aware
money parser added after confirming live that the plain
`int(x.replace(",", "").replace(".", ""))` pattern it replaces either
silently truncated shorthand ("1tr" -> 1) or silently dropped the whole
field with no feedback."""

import sqlite3
import sys
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(SRC_DIR))

from transaction import (
    create_event_plan,
    create_goal,
    deactivate_goal,
    get_goals,
    get_monthly_totals,
    get_transfer_category_id,
    insert_transfer,
    link_event_plan_to_goal,
    parse_amount_vnd,
)


class ParseAmountVndTests(unittest.TestCase):
    def test_plain_digits(self):
        self.assertEqual(parse_amount_vnd("500000"), 500000)

    def test_dot_thousands_separator(self):
        self.assertEqual(parse_amount_vnd("1.500.000"), 1500000)

    def test_comma_thousands_separator(self):
        self.assertEqual(parse_amount_vnd("1,500,000"), 1500000)

    def test_k_shorthand(self):
        self.assertEqual(parse_amount_vnd("500k"), 500000)

    def test_k_shorthand_with_decimal(self):
        self.assertEqual(parse_amount_vnd("1.5k"), 1500)

    def test_tr_shorthand(self):
        self.assertEqual(parse_amount_vnd("1tr"), 1000000)

    def test_tr_shorthand_with_dot_decimal(self):
        self.assertEqual(parse_amount_vnd("1.5tr"), 1500000)

    def test_tr_shorthand_with_comma_decimal(self):
        self.assertEqual(parse_amount_vnd("1,5tr"), 1500000)

    def test_trieu_full_word(self):
        self.assertEqual(parse_amount_vnd("2trieu"), 2000000)

    def test_tr_trailing_digit_colloquial(self):
        # "2tr5" is everyday Vietnamese shorthand for 2.5 trieu, not "2 tr, 5 don"
        self.assertEqual(parse_amount_vnd("2tr5"), 2500000)

    def test_tr_trailing_digit_one(self):
        self.assertEqual(parse_amount_vnd("1tr2"), 1200000)

    def test_ty_shorthand(self):
        self.assertEqual(parse_amount_vnd("2ty"), 2000000000)

    def test_nghin_shorthand(self):
        self.assertEqual(parse_amount_vnd("300nghin"), 300000)

    def test_case_insensitive(self):
        self.assertEqual(parse_amount_vnd("1TR"), 1000000)

    def test_strips_whitespace(self):
        self.assertEqual(parse_amount_vnd("  500000  "), 500000)
        self.assertEqual(parse_amount_vnd("1 tr"), 1000000)

    def test_none_raises(self):
        with self.assertRaises(ValueError):
            parse_amount_vnd(None)

    def test_empty_string_raises(self):
        with self.assertRaises(ValueError):
            parse_amount_vnd("")
        with self.assertRaises(ValueError):
            parse_amount_vnd("   ")

    def test_garbage_raises(self):
        with self.assertRaises(ValueError):
            parse_amount_vnd("abc")

    def test_unrecognized_unit_raises(self):
        with self.assertRaises(ValueError):
            parse_amount_vnd("500xyz")


def build_test_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    conn.executescript((SRC_DIR / "schema.sql").read_text(encoding="utf-8"))
    return conn


def build_test_db_with_goals():
    """build_test_db() plus migration 004 (goals + event_plans.linked_goal_id/
    event_date/goal_prompt_dismissed) — kept as a separate helper rather than
    changing build_test_db() itself, since most tests in this file only need
    the base schema."""
    conn = build_test_db()
    conn.executescript((SRC_DIR / "migrations" / "004_goals.sql").read_text(encoding="utf-8"))
    return conn


class InsertTransferTests(unittest.TestCase):
    """transaction.insert_transfer — moving money between the user's OWN
    accounts, added after finding that categories.kind='transfer' had been
    seeded since Stage 1 but no CLI/web screen ever actually exposed it, so
    a MoMo top-up or ATM withdrawal had no correct way to be recorded
    without polluting income/expense totals."""

    def setUp(self):
        self.conn = build_test_db()
        self.conn.execute(
            "INSERT INTO accounts (id, name, type, current_balance, is_liquid) VALUES (1, 'Bank', 'bank', 1000000, 1)"
        )
        self.conn.execute(
            "INSERT INTO accounts (id, name, type, current_balance, is_liquid) VALUES (2, 'MoMo', 'ewallet', 0, 1)"
        )
        self.conn.execute(
            "INSERT INTO categories (id, name_vi, name_en, kind, stability) VALUES (1, 'Chuyen khoan', 'Transfer', 'transfer', 'variable')"
        )
        self.conn.commit()
        self.cursor = self.conn.cursor()

    def test_moves_balance_between_accounts(self):
        insert_transfer(
            self.cursor, from_account_id=1, to_account_id=2,
            amount=300000, description="Nap MoMo",
        )
        self.conn.commit()
        self.cursor.execute("SELECT current_balance FROM accounts WHERE id = 1")
        self.assertEqual(self.cursor.fetchone()["current_balance"], 700000)
        self.cursor.execute("SELECT current_balance FROM accounts WHERE id = 2")
        self.assertEqual(self.cursor.fetchone()["current_balance"], 300000)

    def test_creates_two_linked_legs_tagged_as_transfer(self):
        out_id, in_id = insert_transfer(
            self.cursor, from_account_id=1, to_account_id=2,
            amount=300000, description="Nap MoMo",
        )
        self.conn.commit()
        self.cursor.execute("SELECT direction, account_id, category_id FROM transactions WHERE id = ?", (out_id,))
        out_row = self.cursor.fetchone()
        self.assertEqual(out_row["direction"], "out")
        self.assertEqual(out_row["account_id"], 1)
        self.assertEqual(out_row["category_id"], 1)
        self.cursor.execute("SELECT direction, account_id, category_id FROM transactions WHERE id = ?", (in_id,))
        in_row = self.cursor.fetchone()
        self.assertEqual(in_row["direction"], "in")
        self.assertEqual(in_row["account_id"], 2)
        self.assertEqual(in_row["category_id"], 1)

    def test_same_account_raises(self):
        with self.assertRaises(ValueError):
            insert_transfer(self.cursor, from_account_id=1, to_account_id=1, amount=1000, description="x")

    def test_missing_transfer_category_raises(self):
        self.cursor.execute("DELETE FROM categories WHERE kind = 'transfer'")
        with self.assertRaises(ValueError):
            insert_transfer(self.cursor, from_account_id=1, to_account_id=2, amount=1000, description="x")

    def test_get_transfer_category_id(self):
        self.assertEqual(get_transfer_category_id(self.cursor), 1)

    def test_get_monthly_totals_excludes_transfer(self):
        self.conn.execute(
            "INSERT INTO categories (id, name_vi, name_en, kind) VALUES (2, 'Thu nhap', 'Income', 'income')"
        )
        self.conn.execute(
            """INSERT INTO transactions (occurred_at, amount, direction, account_id, category_id, description, source, is_reviewed)
               VALUES ('2026-07-10 10:00:00', 1000000, 'in', 1, 2, '', 'manual', 1)"""
        )
        self.conn.commit()
        insert_transfer(self.cursor, from_account_id=1, to_account_id=2, amount=5_000_000, description="x")
        self.conn.commit()
        totals = get_monthly_totals(self.cursor, "2026-07")
        self.assertEqual(totals["income"], 1_000_000)
        self.assertEqual(totals["expense"], 0)


class LinkEventPlanToGoalTests(unittest.TestCase):
    """transaction.link_event_plan_to_goal — found never actually called
    anywhere (Mốc 2, predates the 2026-07-27/29 hardening pass) while
    auditing /events/<id>'s goal-prompt: the "Tạo mục tiêu" link only ever
    pre-filled /goals/new via query params, it never passed event_plan_id
    through or called this function, so linked_goal_id never got set and
    the same prompt would silently reappear on every later visit even after
    the user "accepted" it. Fixed in web_app.py's goals_new(); this covers
    the data-layer half."""

    def setUp(self):
        self.conn = build_test_db_with_goals()
        self.conn.execute(
            "INSERT INTO accounts (id, name, type, current_balance, is_liquid) VALUES (1, 'Test', 'bank', 0, 1)"
        )
        self.conn.commit()
        self.cursor = self.conn.cursor()

    def test_sets_linked_goal_id(self):
        plan_id = create_event_plan(self.cursor, name="Cuoi hoi", event_date="2027-06-01")
        goal_id = create_goal(
            self.cursor, name="Cuoi hoi", goal_type="savings", target_amount=15_000_000,
            deadline="2027-06-01", account_id=1,
        )
        self.conn.commit()
        link_event_plan_to_goal(self.cursor, plan_id, goal_id)
        self.conn.commit()
        self.cursor.execute("SELECT linked_goal_id FROM event_plans WHERE id = ?", (plan_id,))
        self.assertEqual(self.cursor.fetchone()["linked_goal_id"], goal_id)

    def test_noop_for_nonexistent_event_plan(self):
        # Matches this app's existing convention elsewhere (e.g.
        # delete_transaction) of not raising for a stale/missing id.
        link_event_plan_to_goal(self.cursor, 999, 1)  # must not raise


class DeactivateGoalTests(unittest.TestCase):
    """transaction.deactivate_goal — found never actually called anywhere
    (Mốc 2, predates the hardening pass) while auditing for dead code: once
    created, a goal had NO way to ever be marked done/abandoned, since
    get_goals() only ever lists is_active = 1 rows. Wired up to a new
    /goals/<id>/deactivate web route."""

    def setUp(self):
        self.conn = build_test_db_with_goals()
        self.conn.execute(
            "INSERT INTO accounts (id, name, type, current_balance, is_liquid) VALUES (1, 'Test', 'bank', 0, 1)"
        )
        self.conn.commit()
        self.cursor = self.conn.cursor()

    def test_deactivated_goal_no_longer_listed(self):
        goal_id = create_goal(
            self.cursor, name="Done goal", goal_type="savings", target_amount=1_000_000,
            deadline="2027-01-01", account_id=1,
        )
        self.conn.commit()
        self.assertEqual(len(get_goals(self.cursor)), 1)
        deactivate_goal(self.cursor, goal_id)
        self.conn.commit()
        self.assertEqual(len(get_goals(self.cursor)), 0)


if __name__ == "__main__":
    unittest.main()
