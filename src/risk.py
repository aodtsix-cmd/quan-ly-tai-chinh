from datetime import date, timedelta

import period

SPEND_LOOKBACK_DAYS = 30
ESSENTIAL_LOOKBACK_PERIODS = 3
SAVINGS_TREND_LOOKBACK_PERIODS = 6

RUNWAY_LEVELS = ("nguy_hiem", "mong_manh", "on", "vung")


def get_liquid_balance(cursor):
    cursor.execute(
        "SELECT COALESCE(SUM(current_balance), 0) AS total FROM accounts WHERE is_liquid = 1 AND is_active = 1"
    )
    return cursor.fetchone()["total"]


def get_average_period_essential_expense(cursor, periods=ESSENTIAL_LOOKBACK_PERIODS, as_of=None):
    """Average essential (`categories.necessity = 'essential'`) expense per
    financial period (see period.py — default the 15th-to-14th cycle, not a
    calendar month), over the last `periods` *completed* periods that
    actually contain essential spending. Returns None if there's no such
    period at all.

    Periods with zero essential spending are skipped rather than counted as
    0 — same semantics the original calendar-month version had (via SQL
    GROUP BY, which only ever produces a row for a month that has at least
    one matching transaction): a genuinely empty period silently dragging
    the average down would understate the number that liquidity_risk/
    runway_months use to judge whether savings are enough, which is the
    wrong direction to be wrong in for a safety metric."""
    start_day = period.get_period_start_day(cursor)
    as_of_date = as_of or date.today()
    current_id = period.current_period_id(cursor, as_of_date)

    cursor.execute(
        """SELECT t.occurred_at, t.amount
           FROM transactions t JOIN categories c ON t.category_id = c.id
           WHERE t.direction = 'out' AND c.necessity = 'essential'"""
    )
    totals_by_period = {}
    for row in cursor.fetchall():
        occurred_date = date.fromisoformat(row["occurred_at"][:10])
        period_id = period.period_id_for(occurred_date, start_day)
        if period_id >= current_id:
            continue  # exclude the still-open current period, mirrors the old "< as_of month" filter
        totals_by_period[period_id] = totals_by_period.get(period_id, 0) + row["amount"]

    recent_ids = sorted(totals_by_period.keys(), reverse=True)[:periods]
    if not recent_ids:
        return None
    return sum(totals_by_period[pid] for pid in recent_ids) / len(recent_ids)


def get_remaining_recurring_this_period(cursor, as_of=None):
    """Sum of active 'out' recurring items whose next_due falls later in the
    current financial period (items due today or earlier are assumed already
    generated into real transactions by generate_due_recurring — don't
    double count them)."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    _, period_end = period.period_bounds(as_of_date, start_day)
    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM recurring
           WHERE is_active = 1 AND direction = 'out'
             AND next_due > ? AND next_due <= ?""",
        (as_of_date.isoformat(), period_end.isoformat()),
    )
    return cursor.fetchone()["total"]


def get_average_daily_variable_spend(cursor, days=SPEND_LOOKBACK_DAYS, as_of=None):
    """Average daily 'out' spend from non-recurring sources (manual entries,
    rule-categorized or not) over the trailing `days` — recurring-sourced
    transactions are excluded since they're already accounted for separately
    via get_remaining_recurring_this_period. A rolling day-count window, not
    tied to calendar months or financial periods either way — unaffected by
    the period retrofit."""
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
    the end of the current financial period."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    days_remaining = period.days_elapsed_and_remaining_for(as_of_date, start_day)["remaining_days"]

    liquid_balance = get_liquid_balance(cursor)
    remaining_recurring = get_remaining_recurring_this_period(cursor, as_of_date)
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
    """THIET-KE.md 4.2 — "Rủi ro thanh khoản": liquid assets vs. one period
    of essential expenses. Returns sufficient=None when there's not yet
    enough history to estimate essential period expense."""
    liquid_balance = get_liquid_balance(cursor)
    essential_period_expense = get_average_period_essential_expense(cursor)
    sufficient = (
        liquid_balance >= essential_period_expense
        if essential_period_expense is not None
        else None
    )
    return {
        "liquid_balance": liquid_balance,
        "essential_monthly_expense": essential_period_expense,
        "sufficient": sufficient,
    }


def get_reliable_monthly_income(cursor):
    """THIET-KE.md 3.7: weight each active income source's expected monthly
    amount by its reliability — the "chắc chắn" (certain) portion to use in
    forecasts, not the raw total. An unreliable side gig isn't a foundation
    to plan around, even if its expected amount is large. Returns None if no
    income sources have been entered yet (distinct from 0, which would mean
    "entered sources that sum to zero reliable income").

    Kept named/shaped as a monthly figure, not a period one — income_sources
    stores an "expected monthly amount", a stated user input independent of
    the financial-period cycle, not a transaction-derived aggregate."""
    cursor.execute("SELECT expected_amount, reliability FROM income_sources WHERE is_active = 1")
    rows = cursor.fetchall()
    if not rows:
        return None
    return sum(row["expected_amount"] * row["reliability"] / 100 for row in rows)


def income_sustainability_margin(cursor):
    """Reliable monthly income (see get_reliable_monthly_income) vs. average
    essential period expense — a different question from runway_months,
    which only asks how long *existing savings* would last with zero income.
    This asks whether *ongoing* reliable income already covers the essential
    baseline, independent of savings. has_data is False until both an income
    source and at least one completed period of essential spending exist."""
    reliable_income = get_reliable_monthly_income(cursor)
    essential_period_expense = get_average_period_essential_expense(cursor)
    if reliable_income is None or essential_period_expense is None:
        return {
            "has_data": False,
            "reliable_income": reliable_income,
            "essential_monthly_expense": essential_period_expense,
            "margin": None,
            "sufficient": None,
        }

    margin = reliable_income - essential_period_expense
    return {
        "has_data": True,
        "reliable_income": reliable_income,
        "essential_monthly_expense": essential_period_expense,
        "margin": margin,
        "sufficient": margin >= 0,
    }


def runway_months(cursor):
    """THIET-KE.md 4.3 — "Nền móng tài chính": liquid assets ÷ essential
    period expense = number of periods of runway if income stopped (still
    called "months" in the field names/function name for continuity with
    THIET-KE.md's own wording and every existing caller — a "period" here
    defaults to roughly a month in length regardless). The doc's own
    reference bands: <1 nguy hiểm, 1–3 mong manh, 3–6 ổn, >6 vững."""
    liquid_balance = get_liquid_balance(cursor)
    essential_period_expense = get_average_period_essential_expense(cursor)
    if not essential_period_expense:
        return {"months": None, "level": None, "liquid_balance": liquid_balance,
                "essential_monthly_expense": essential_period_expense}

    months = liquid_balance / essential_period_expense
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
        "essential_monthly_expense": essential_period_expense,
    }


def budget_balance_50_30_20(cursor, period_id):
    """THIET-KE.md 4.4 — spending grouped by categories.necessity vs. income
    for one financial period (identified by `period_id`, a 'YYYY-MM'-shaped
    id from period.py — see that module; NOT necessarily a calendar month).
    Recommended bands: essential ≤ 50%, optional ≤ 30%, savings (what's
    left) ≥ 20% of income."""
    start_day = period.get_period_start_day(cursor)
    period_start, period_end = period.period_bounds_for_id(period_id, start_day)

    cursor.execute(
        """SELECT c.necessity AS necessity, SUM(t.amount) AS total
           FROM transactions t
           JOIN categories c ON t.category_id = c.id
           WHERE t.direction = 'out' AND date(t.occurred_at) BETWEEN ? AND ?
           GROUP BY c.necessity""",
        (period_start.isoformat(), period_end.isoformat()),
    )
    by_necessity = {row["necessity"]: row["total"] for row in cursor.fetchall()}
    essential = by_necessity.get("essential", 0)
    optional = by_necessity.get("optional", 0)

    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE direction = 'in' AND date(occurred_at) BETWEEN ? AND ?""",
        (period_start.isoformat(), period_end.isoformat()),
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


def get_savings_rate_trend(cursor, periods=SAVINGS_TREND_LOOKBACK_PERIODS, as_of=None):
    """Savings rate (= (income − expense) / income) per financial period over
    the last `periods` *completed* periods that have any transaction at all
    (current partial period excluded, same convention as
    get_average_period_essential_expense — a half-spent period would
    understate expense and overstate the rate; and same "skip periods with
    no data rather than counting them as 0" semantics too).

    Unlike the 50/30/20 snapshot (one period, categorized by necessity), this
    tracks *direction of change* — personal-finance literature (e.g. the
    FIRE/"shockingly simple math" line of thinking, but really any life-cycle
    savings model) treats the savings rate, not the absolute amount saved, as
    the number that actually predicts financial trajectory: someone earning
    little but saving 30% is on a better path than someone earning a lot but
    saving 5%. None of the other metrics show whether that rate is rising or
    falling over time — this is the only one that does.

    Returns {"periods": [{period_id, income, expense, savings, savings_rate},
    ...] oldest-first, "trend": "improving"/"declining"/"stable"/None}. trend
    is None until at least 2 periods have a defined rate (income > 0)."""
    start_day = period.get_period_start_day(cursor)
    as_of_date = as_of or date.today()
    current_id = period.current_period_id(cursor, as_of_date)

    cursor.execute("SELECT occurred_at, amount, direction FROM transactions")
    income_by_period = {}
    expense_by_period = {}
    seen_periods = set()
    for row in cursor.fetchall():
        occurred_date = date.fromisoformat(row["occurred_at"][:10])
        period_id = period.period_id_for(occurred_date, start_day)
        if period_id >= current_id:
            continue
        seen_periods.add(period_id)
        if row["direction"] == "in":
            income_by_period[period_id] = income_by_period.get(period_id, 0) + row["amount"]
        else:
            expense_by_period[period_id] = expense_by_period.get(period_id, 0) + row["amount"]

    recent_ids = sorted(seen_periods, reverse=True)[:periods]
    recent_ids.reverse()  # oldest -> newest, for trend reading

    data = []
    for period_id in recent_ids:
        income = income_by_period.get(period_id, 0)
        expense = expense_by_period.get(period_id, 0)
        savings = income - expense
        savings_rate = (savings / income * 100) if income > 0 else None
        data.append({
            "period_id": period_id,
            "income": income,
            "expense": expense,
            "savings": savings,
            "savings_rate": savings_rate,
        })

    rates = [d["savings_rate"] for d in data if d["savings_rate"] is not None]
    if len(rates) >= 2:
        if rates[-1] > rates[0]:
            trend = "improving"
        elif rates[-1] < rates[0]:
            trend = "declining"
        else:
            trend = "stable"
    else:
        trend = None

    return {"periods": data, "trend": trend}


def get_budget_status(cursor, month):
    """"Hũ chi tiêu" (envelope budgeting, THIET-KE.md 7.3 — noted there as
    "chưa triển khai" at the time). For every category with an active
    budget, how much of its `monthly_limit` has been spent in the given
    'YYYY-MM' CALENDAR month. Returns an empty list if no budgets have been
    set.

    Deliberately NOT retrofitted to financial periods — `budgets` and this
    function are superseded by `period_budgets` / get_period_budget_status
    (Mốc 1's actual new budgeting feature) but kept exactly as they were,
    orphaned rather than migrated in place: no data is lost, nothing breaks,
    but new code should read period_budgets instead of writing to this
    table going forward."""
    cursor.execute(
        """SELECT b.category_id, b.monthly_limit, c.name_vi AS category_name
           FROM budgets b JOIN categories c ON b.category_id = c.id
           WHERE b.is_active = 1
           ORDER BY c.name_vi"""
    )
    budgets = cursor.fetchall()

    statuses = []
    for b in budgets:
        cursor.execute(
            """SELECT COALESCE(SUM(amount), 0) AS spent FROM transactions
               WHERE direction = 'out' AND category_id = ?
                 AND strftime('%Y-%m', occurred_at) = ?""",
            (b["category_id"], month),
        )
        spent = cursor.fetchone()["spent"]
        statuses.append({
            "category_id": b["category_id"],
            "category_name": b["category_name"],
            "monthly_limit": b["monthly_limit"],
            "spent": spent,
            "remaining": b["monthly_limit"] - spent,
            "pct_used": spent / b["monthly_limit"] * 100,
            "over_budget": spent > b["monthly_limit"],
        })
    return statuses


BUDGET_SUGGESTION_LOOKBACK_PERIODS = 3


def get_actual_spend_in_period(cursor, category_id, period_id, start_day):
    period_start, period_end = period.period_bounds_for_id(period_id, start_day)
    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE direction = 'out' AND category_id = ?
             AND date(occurred_at) BETWEEN ? AND ?""",
        (category_id, period_start.isoformat(), period_end.isoformat()),
    )
    return cursor.fetchone()["total"]


def suggest_period_budget_amounts(cursor, period_id, periods=BUDGET_SUGGESTION_LOOKBACK_PERIODS):
    """Formula-based budget suggestion (Mốc 1, way (b) of 3) for every
    expense category that has a `stability` set:
      - 'fixed'    -> same amount as the previous period's budget for that
                       category, if one was ever set (falls back to the
                       'variable' rule below when there's no previous budget
                       to copy yet — nothing to keep "the same" as).
      - 'variable' -> average ACTUAL spend in that category over the last
                       `periods` completed periods, treating a period with no
                       spending as 0 (unlike the essential-expense average in
                       this same module, which skips zero periods to avoid
                       understating a safety number — here a genuinely
                       unused category IS the signal: it should suggest a
                       lower budget, not have the zero explained away).

    Categories with no `stability` set are skipped (nothing to suggest from
    formula alone; the user can still enter an amount manually). A category
    whose computed suggestion is 0 is also skipped — suggesting an 0đ budget
    isn't useful.

    Returns {category_id: {"amount": int, "source": "suggested_fixed"|"suggested_variable"}}."""
    start_day = period.get_period_start_day(cursor)
    prev_period_id = period.shift_period_id(period_id, -1, start_day)
    recent_ids = period.recent_period_ids_for(period_id, periods, start_day, include_current=False)

    cursor.execute("SELECT id, stability FROM categories WHERE kind = 'expense' AND stability IS NOT NULL")
    categories = cursor.fetchall()

    suggestions = {}
    for cat in categories:
        category_id, stability = cat["id"], cat["stability"]

        if stability == "fixed":
            cursor.execute(
                "SELECT amount FROM period_budgets WHERE category_id = ? AND period_id = ?",
                (category_id, prev_period_id),
            )
            prev_row = cursor.fetchone()
            if prev_row is not None:
                suggestions[category_id] = {"amount": prev_row["amount"], "source": "suggested_fixed"}
                continue
            # no previous budget to copy — fall through to the averaging below

        total = sum(get_actual_spend_in_period(cursor, category_id, pid, start_day) for pid in recent_ids)
        average = round(total / len(recent_ids)) if recent_ids else 0
        if average > 0:
            suggestions[category_id] = {"amount": average, "source": "suggested_variable"}

    return suggestions


def get_period_budget_status(cursor, period_id):
    """Like get_budget_status, but reads period_budgets (Mốc 1's per-period
    system) instead of the old calendar-month `budgets` table."""
    start_day = period.get_period_start_day(cursor)
    budgets = get_period_budgets_for_status(cursor, period_id)

    statuses = []
    for b in budgets:
        spent = get_actual_spend_in_period(cursor, b["category_id"], period_id, start_day)
        statuses.append({
            "category_id": b["category_id"],
            "category_name": b["category_name"],
            "amount": b["amount"],
            "spent": spent,
            "remaining": b["amount"] - spent,
            "pct_used": spent / b["amount"] * 100,
            "over_budget": spent > b["amount"],
        })
    return statuses


def get_period_budgets_for_status(cursor, period_id):
    """Thin local query (not transaction.py's get_period_budgets) to avoid
    risk.py importing from transaction.py — same one-way dependency
    direction risk.py already keeps with period.py."""
    cursor.execute(
        """SELECT pb.category_id, pb.amount, c.name_vi AS category_name
           FROM period_budgets pb JOIN categories c ON pb.category_id = c.id
           WHERE pb.period_id = ?
           ORDER BY c.name_vi""",
        (period_id,),
    )
    return cursor.fetchall()
