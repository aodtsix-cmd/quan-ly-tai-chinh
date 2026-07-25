import calendar
from datetime import date, timedelta

SPEND_LOOKBACK_DAYS = 30
ESSENTIAL_LOOKBACK_MONTHS = 3

RUNWAY_LEVELS = ("nguy_hiem", "mong_manh", "on", "vung")


def get_liquid_balance(cursor):
    cursor.execute(
        "SELECT COALESCE(SUM(current_balance), 0) AS total FROM accounts WHERE is_liquid = 1 AND is_active = 1"
    )
    return cursor.fetchone()["total"]


def get_average_monthly_essential_expense(cursor, months=ESSENTIAL_LOOKBACK_MONTHS, as_of=None):
    """Average essential (`categories.necessity = 'essential'`) expense per
    calendar month, over the last `months` *completed* months (the current,
    still-open month is excluded so a partial month doesn't skew the average).
    Returns None if there isn't at least one completed month of data."""
    as_of_date = as_of or date.today()
    cursor.execute(
        """SELECT strftime('%Y-%m', t.occurred_at) AS month, SUM(t.amount) AS total
           FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.direction = 'out' AND c.necessity = 'essential'
             AND strftime('%Y-%m', t.occurred_at) < ?
           GROUP BY month
           ORDER BY month DESC
           LIMIT ?""",
        (as_of_date.strftime("%Y-%m"), months),
    )
    rows = cursor.fetchall()
    if not rows:
        return None
    return sum(row["total"] for row in rows) / len(rows)


def get_remaining_recurring_this_month(cursor, as_of=None):
    """Sum of active 'out' recurring items whose next_due falls later this
    month (items due today or earlier are assumed already generated into
    real transactions by generate_due_recurring — don't double count them)."""
    as_of_date = as_of or date.today()
    last_day = calendar.monthrange(as_of_date.year, as_of_date.month)[1]
    month_end = date(as_of_date.year, as_of_date.month, last_day)
    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM recurring
           WHERE is_active = 1 AND direction = 'out'
             AND next_due > ? AND next_due <= ?""",
        (as_of_date.isoformat(), month_end.isoformat()),
    )
    return cursor.fetchone()["total"]


def get_average_daily_variable_spend(cursor, days=SPEND_LOOKBACK_DAYS, as_of=None):
    """Average daily 'out' spend from non-recurring sources (manual entries,
    rule-categorized or not) over the trailing `days` — recurring-sourced
    transactions are excluded since they're already accounted for separately
    via get_remaining_recurring_this_month."""
    as_of_date = as_of or date.today()
    start_date = as_of_date - timedelta(days=days)
    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE direction = 'out' AND source != 'recurring'
             AND date(occurred_at) > ? AND date(occurred_at) <= ?""",
        (start_date.isoformat(), as_of_date.isoformat()),
    )
    total = cursor.fetchone()["total"]
    return total / days


def short_term_forecast(cursor, as_of=None):
    """THIET-KE.md 4.1 — "Hết tiền ngắn hạn": projected available balance at
    the end of the current month."""
    as_of_date = as_of or date.today()
    last_day = calendar.monthrange(as_of_date.year, as_of_date.month)[1]
    days_remaining = last_day - as_of_date.day

    liquid_balance = get_liquid_balance(cursor)
    remaining_recurring = get_remaining_recurring_this_month(cursor, as_of_date)
    daily_rate = get_average_daily_variable_spend(cursor, as_of=as_of_date)
    projected_variable_spend = round(daily_rate * days_remaining)

    forecast_balance = liquid_balance - remaining_recurring - projected_variable_spend

    return {
        "liquid_balance": liquid_balance,
        "remaining_recurring": remaining_recurring,
        "projected_variable_spend": projected_variable_spend,
        "forecast_balance": forecast_balance,
        "days_remaining": days_remaining,
        "at_risk": forecast_balance < 0,
    }


def liquidity_risk(cursor):
    """THIET-KE.md 4.2 — "Rủi ro thanh khoản": liquid assets vs. one month
    of essential expenses. Returns sufficient=None when there's not yet
    enough history to estimate essential monthly expense."""
    liquid_balance = get_liquid_balance(cursor)
    essential_monthly_expense = get_average_monthly_essential_expense(cursor)
    sufficient = (
        liquid_balance >= essential_monthly_expense
        if essential_monthly_expense is not None
        else None
    )
    return {
        "liquid_balance": liquid_balance,
        "essential_monthly_expense": essential_monthly_expense,
        "sufficient": sufficient,
    }


def get_reliable_monthly_income(cursor):
    """THIET-KE.md 3.7: weight each active income source's expected monthly
    amount by its reliability — the "chắc chắn" (certain) portion to use in
    forecasts, not the raw total. An unreliable side gig isn't a foundation
    to plan around, even if its expected amount is large. Returns None if no
    income sources have been entered yet (distinct from 0, which would mean
    "entered sources that sum to zero reliable income")."""
    cursor.execute("SELECT expected_amount, reliability FROM income_sources WHERE is_active = 1")
    rows = cursor.fetchall()
    if not rows:
        return None
    return sum(row["expected_amount"] * row["reliability"] / 100 for row in rows)


def income_sustainability_margin(cursor):
    """Reliable monthly income (see get_reliable_monthly_income) vs. average
    essential monthly expense — a different question from runway_months,
    which only asks how long *existing savings* would last with zero income.
    This asks whether *ongoing* reliable income already covers the essential
    baseline, independent of savings. has_data is False until both an income
    source and at least one completed month of essential spending exist."""
    reliable_income = get_reliable_monthly_income(cursor)
    essential_monthly_expense = get_average_monthly_essential_expense(cursor)
    if reliable_income is None or essential_monthly_expense is None:
        return {
            "has_data": False,
            "reliable_income": reliable_income,
            "essential_monthly_expense": essential_monthly_expense,
            "margin": None,
            "sufficient": None,
        }

    margin = reliable_income - essential_monthly_expense
    return {
        "has_data": True,
        "reliable_income": reliable_income,
        "essential_monthly_expense": essential_monthly_expense,
        "margin": margin,
        "sufficient": margin >= 0,
    }


def runway_months(cursor):
    """THIET-KE.md 4.3 — "Nền móng tài chính": liquid assets ÷ essential
    monthly expense = months of runway if income stopped. The doc's own
    reference bands: <1 nguy hiểm, 1–3 mong manh, 3–6 ổn, >6 vững."""
    liquid_balance = get_liquid_balance(cursor)
    essential_monthly_expense = get_average_monthly_essential_expense(cursor)
    if not essential_monthly_expense:
        return {"months": None, "level": None, "liquid_balance": liquid_balance,
                "essential_monthly_expense": essential_monthly_expense}

    months = liquid_balance / essential_monthly_expense
    if months < 1:
        level = "nguy_hiem"
    elif months < 3:
        level = "mong_manh"
    elif months < 6:
        level = "on"
    else:
        level = "vung"

    return {
        "months": months,
        "level": level,
        "liquid_balance": liquid_balance,
        "essential_monthly_expense": essential_monthly_expense,
    }


def budget_balance_50_30_20(cursor, month):
    """THIET-KE.md 4.4 — spending grouped by categories.necessity vs. income
    for a 'YYYY-MM' month. Recommended bands: essential ≤ 50%, optional ≤ 30%,
    savings (what's left) ≥ 20% of income."""
    cursor.execute(
        """SELECT c.necessity AS necessity, SUM(t.amount) AS total
           FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.direction = 'out' AND strftime('%Y-%m', t.occurred_at) = ?
           GROUP BY c.necessity""",
        (month,),
    )
    by_necessity = {row["necessity"]: row["total"] for row in cursor.fetchall()}
    essential = by_necessity.get("essential", 0)
    optional = by_necessity.get("optional", 0)

    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE direction = 'in' AND strftime('%Y-%m', occurred_at) = ?""",
        (month,),
    )
    income = cursor.fetchone()["total"]
    savings = income - essential - optional

    if income > 0:
        essential_pct = essential / income * 100
        optional_pct = optional / income * 100
        savings_pct = savings / income * 100
    else:
        essential_pct = optional_pct = savings_pct = None

    return {
        "income": income,
        "essential": essential,
        "optional": optional,
        "savings": savings,
        "essential_pct": essential_pct,
        "optional_pct": optional_pct,
        "savings_pct": savings_pct,
    }
