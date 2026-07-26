import calendar
import statistics
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


def suggest_emergency_fund_target(cursor):
    """Mốc 2's built-in "Quỹ khẩn cấp" goal type suggests its own target:
    6× average essential period expense — the upper end of THIET-KE.md
    7.3's "quỹ khẩn cấp 3–6 tháng" reference band (same source as
    runway_months' bands). Returns None if there's not yet enough essential-
    spending history to estimate from (same has_data convention as
    get_average_period_essential_expense itself)."""
    essential = get_average_period_essential_expense(cursor)
    return round(essential * 6) if essential is not None else None


def get_goal_progress(cursor, goal, as_of=None):
    """`goal` is a row from transaction.get_goals()/get_goal_by_id() (needs
    target_amount, deadline, created_at, current_balance). Progress is read
    live from the goal's linked account balance — see CLAUDE.md/goals for
    why there's no separately-tracked running total to drift out of sync.

    "Off track" compares actual progress % against a simple LINEAR
    expectation from the goal's creation date to its deadline — e.g. halfway
    through the timeline, you'd expect to be at ~50% — not a real forecast
    (Mốc 4's cashflow forecast is the place for that); this is just "by a
    straight-line schedule, where should you be by now.\""""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)

    target = goal["target_amount"]
    current = goal["current_balance"]
    progress_pct = min(current / target * 100, 100) if target > 0 else 0
    remaining_amount = max(target - current, 0)

    deadline_date = date.fromisoformat(goal["deadline"])
    created_date = date.fromisoformat(goal["created_at"][:10])
    current_id = period.period_id_for(as_of_date, start_day)
    deadline_id = period.period_id_for(deadline_date, start_day)
    created_id = period.period_id_for(created_date, start_day)

    periods_remaining = max(period.periods_between(current_id, deadline_id) + 1, 0)
    required_per_period = round(remaining_amount / periods_remaining) if periods_remaining > 0 else remaining_amount

    total_periods = max(period.periods_between(created_id, deadline_id) + 1, 1)
    elapsed_periods = min(max(period.periods_between(created_id, current_id) + 1, 0), total_periods)
    expected_pct = elapsed_periods / total_periods * 100

    is_overdue = deadline_date < as_of_date and remaining_amount > 0
    is_off_track = (not is_overdue) and (progress_pct + 5 < expected_pct)

    return {
        "progress_pct": progress_pct,
        "remaining_amount": remaining_amount,
        "periods_remaining": periods_remaining,
        "required_per_period": required_per_period,
        "expected_pct": expected_pct,
        "is_overdue": is_overdue,
        "is_off_track": is_off_track,
    }


# ---------- Spending-decision simulation (Mốc 3) ----------

BASELINE_FLOW_LOOKBACK_PERIODS = 3
SIMULATION_TRAJECTORY_PERIODS = 12
INSTALLMENT_OPTIONS = (3, 6, 12)
DELAY_OPTIONS = (3, 6)


def get_baseline_period_flow(cursor, periods=BASELINE_FLOW_LOOKBACK_PERIODS, as_of=None):
    """Average income/expense per period over the last `periods` completed
    periods that have any transaction (reuses get_savings_rate_trend's own
    data rather than re-querying) — the "business as usual" run rate used to
    project forward in project_simple_trajectory. {0, 0} if there's no
    history yet."""
    trend = get_savings_rate_trend(cursor, periods=periods, as_of=as_of)
    data = trend["periods"]
    if not data:
        return {"avg_income": 0, "avg_expense": 0}
    return {
        "avg_income": sum(d["income"] for d in data) / len(data),
        "avg_expense": sum(d["expense"] for d in data) / len(data),
    }


def project_simple_trajectory(cursor, periods_ahead, extra_expenses=None, as_of=None):
    """Projected liquid balance at the end of each of the next `periods_ahead`
    periods, continuing the recent average income/expense flat (see
    get_baseline_period_flow) — deliberately simple, NOT a real forecast
    with seasonality/goals/budgets layered in (that's Mốc 4's job; this
    function exists only to power Mốc 3's "with vs. without this expense"
    comparison chart, and Mốc 4 may reuse or replace it, not extend it in place
    without checking whether its own richer model already supersedes this).

    `extra_expenses`: optional {period_offset: amount} to layer hypothetical
    spending on top, 0-indexed from the current (still-open) period."""
    flow = get_baseline_period_flow(cursor, as_of=as_of)
    balance = get_liquid_balance(cursor)
    extra_expenses = extra_expenses or {}
    trajectory = []
    for offset in range(periods_ahead):
        balance = balance + flow["avg_income"] - flow["avg_expense"] - extra_expenses.get(offset, 0)
        trajectory.append(round(balance))
    return trajectory


def traffic_light_for_trajectory(cursor, trajectory):
    """green: never dips below one period's essential expense (the same
    threshold liquidity_risk itself uses for "sufficient"). yellow: dips
    below that but never negative. red: goes negative at some point. Falls
    back to a plain negative/non-negative check when there isn't yet enough
    essential-spend history to know the threshold (no yellow tier then —
    not enough data to justify the finer distinction)."""
    if any(b < 0 for b in trajectory):
        return "red"
    essential = get_average_period_essential_expense(cursor)
    if essential is not None and any(b < essential for b in trajectory):
        return "yellow"
    return "green"


def compute_spending_scenarios(cursor, *, item_amount, maintenance_cost_per_period=0, expected_lifetime_periods=0):
    """Builds Mốc 3's full scenario comparison — pay now, installments over
    each of INSTALLMENT_OPTIONS periods, and delay by each of DELAY_OPTIONS
    periods — plus the no-expense baseline for the same window, for the
    "with vs. without" chart. Every number here is plain Python arithmetic;
    no AI involved anywhere in this function, per the app's standing rule
    that AI never computes money.

    total_cost_of_ownership is the SAME figure across every scenario
    (item_amount + maintenance × lifetime) — no financing/interest cost is
    modeled, since none was asked for and inventing an interest rate would
    be a real number this app has no basis to assume. What differs between
    scenarios is only the *timing* of the cash outflow.

    Returns (scenarios, baseline_balances) — scenarios is a list of
    {"scenario_type", "installment_periods", "delay_periods",
    "total_cost_of_ownership", "projected_balances", "traffic_light"}."""
    total_cost_of_ownership = item_amount + maintenance_cost_per_period * expected_lifetime_periods
    baseline_balances = project_simple_trajectory(cursor, SIMULATION_TRAJECTORY_PERIODS)

    def maintenance_schedule(start_offset):
        schedule = {}
        end_offset = start_offset + expected_lifetime_periods
        for offset in range(start_offset, min(end_offset, SIMULATION_TRAJECTORY_PERIODS)):
            schedule[offset] = schedule.get(offset, 0) + maintenance_cost_per_period
        return schedule

    def build_scenario(scenario_type, installment_periods, delay_periods, extra_expenses):
        trajectory = project_simple_trajectory(cursor, SIMULATION_TRAJECTORY_PERIODS, extra_expenses=extra_expenses)
        return {
            "scenario_type": scenario_type,
            "installment_periods": installment_periods,
            "delay_periods": delay_periods,
            "total_cost_of_ownership": total_cost_of_ownership,
            "projected_balances": trajectory,
            "traffic_light": traffic_light_for_trajectory(cursor, trajectory),
        }

    scenarios = []

    pay_now_extra = maintenance_schedule(0)
    pay_now_extra[0] = pay_now_extra.get(0, 0) + item_amount
    scenarios.append(build_scenario("pay_now", 1, 0, pay_now_extra))

    for n in INSTALLMENT_OPTIONS:
        extra = maintenance_schedule(0)
        per_period = round(item_amount / n)
        for offset in range(n):
            extra[offset] = extra.get(offset, 0) + per_period
        scenarios.append(build_scenario("installments", n, 0, extra))

    for n in DELAY_OPTIONS:
        extra = maintenance_schedule(n)
        extra[n] = extra.get(n, 0) + item_amount
        scenarios.append(build_scenario("delay", 1, n, extra))

    return scenarios, baseline_balances


# ---------- Cashflow forecasting (Mốc 4) ----------

RECURRING_STEP_MONTHS = {"monthly": 1, "quarterly": 3, "yearly": 12}
SEASONALITY_MIN_PERIODS = 12
SEASONALITY_PCT_THRESHOLD = 15


def _step_months(d, months):
    """Same day-clamping convention as period.py's/transaction.py's own
    _add_months — duplicated here rather than imported, for the same
    one-way-dependency reason period.py already documents (risk.py is
    imported by transaction.py, so importing back would cycle)."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def project_recurring_by_period(cursor, period_ids):
    """{period_id: {"in": total, "out": total}} for every id in `period_ids`,
    by simulating each active recurring item's own occurrences forward from
    its real next_due using its real frequency — a quarterly item must NOT
    show up in every single period, only the ones it actually falls in."""
    cursor.execute("SELECT amount, direction, frequency, next_due FROM recurring WHERE is_active = 1")
    rows = cursor.fetchall()

    totals = {pid: {"in": 0, "out": 0} for pid in period_ids}
    period_id_set = set(period_ids)
    last_period_id = max(period_ids) if period_ids else None
    start_day = period.get_period_start_day(cursor)

    for row in rows:
        step = RECURRING_STEP_MONTHS[row["frequency"]]
        occurrence = date.fromisoformat(row["next_due"])
        for _ in range(400):  # safety cap — generous even for a 12-period/yearly-frequency window
            occ_period_id = period.period_id_for(occurrence, start_day)
            if last_period_id is None or occ_period_id > last_period_id:
                break
            if occ_period_id in period_id_set:
                totals[occ_period_id][row["direction"]] += row["amount"]
            occurrence = _step_months(occurrence, step)

    return totals


def detect_seasonality(cursor, as_of=None):
    """Descriptive statistics only — mean/stdev total 'out' spend per
    calendar-month-position (Jan..Dec) vs. the overall period average,
    using every *completed* period of history (needs >= SEASONALITY_MIN_
    PERIODS to say anything at all — less than one full annual cycle isn't
    enough to call something seasonal). This function only ever SUGGESTS: it
    never decides on its own to feed into a forecast — the confidence
    threshold (SEASONALITY_PCT_THRESHOLD) is fixed, deterministic Python,
    not something an AI call adjusts; an AI may only *describe* what this
    returns in words, per the user's explicit "AI diễn giải căn cứ đó,
    nhưng ngưỡng tin cậy do công thức quyết định" requirement.

    Returns {"has_enough_data": bool, "periods_analyzed": int,
             "patterns": [{"month", "avg_expense", "overall_avg",
                            "pct_difference", "stdev", "sample_count"}, ...]}
    — patterns only includes month-positions seen >= 2 times whose average
    differs from the overall average by at least SEASONALITY_PCT_THRESHOLD%,
    sorted by how large that difference is."""
    start_day = period.get_period_start_day(cursor)
    as_of_date = as_of or date.today()
    current_id = period.current_period_id(cursor, as_of_date)

    cursor.execute("SELECT occurred_at, amount FROM transactions WHERE direction = 'out'")
    expense_by_period = {}
    for row in cursor.fetchall():
        occurred_date = date.fromisoformat(row["occurred_at"][:10])
        pid = period.period_id_for(occurred_date, start_day)
        if pid >= current_id:
            continue
        expense_by_period[pid] = expense_by_period.get(pid, 0) + row["amount"]

    periods_analyzed = len(expense_by_period)
    if periods_analyzed < SEASONALITY_MIN_PERIODS:
        return {"has_enough_data": False, "periods_analyzed": periods_analyzed, "patterns": []}

    overall_avg = sum(expense_by_period.values()) / periods_analyzed

    by_month = {}
    for pid, total in expense_by_period.items():
        month = int(pid.split("-")[1])
        by_month.setdefault(month, []).append(total)

    patterns = []
    for month, totals in by_month.items():
        if len(totals) < 2:
            continue
        avg = sum(totals) / len(totals)
        pct_difference = (avg - overall_avg) / overall_avg * 100 if overall_avg else 0
        if abs(pct_difference) >= SEASONALITY_PCT_THRESHOLD:
            patterns.append({
                "month": month,
                "avg_expense": round(avg),
                "overall_avg": round(overall_avg),
                "pct_difference": round(pct_difference, 1),
                "stdev": round(statistics.stdev(totals)),
                "sample_count": len(totals),
            })

    patterns.sort(key=lambda p: -abs(p["pct_difference"]))
    return {"has_enough_data": True, "periods_analyzed": periods_analyzed, "patterns": patterns}


def compute_cashflow_forecast(cursor, periods_ahead, goal_contribution_per_period=0,
                               irregular_income_by_offset=None, seasonality_patterns=None, as_of=None):
    """Mốc 4's core forecast: projected balance at the end of each of the
    next `periods_ahead` periods (6–12 per the spec), chaining each period's
    ending balance into the next one's starting balance. Combines:
      - recurring commitments, via project_recurring_by_period (real
        per-item frequency, not "one per period")
      - reliable monthly income from income_sources (get_reliable_monthly_
        income), applied every period
      - "other variable spend" = recent historical average total expense
        minus recent average recurring expense (same approach Mốc 3's
        project_simple_trajectory uses) — deliberately NOT period_budgets
        directly: a budgeted category can also be a recurring item, and
        reconciling that overlap correctly is a real double-counting risk;
        budgets are shown as informational context next to the forecast
        instead (see web_app.py), not folded into this number
      - goal_contribution_per_period: the caller's own precomputed sum of
        every active goal's required_per_period (risk.py can't import
        transaction.py's get_goals — same one-way dependency rule as
        elsewhere — so the caller passes this in already computed).
        Applied as a FLAT amount for every period in this forecast, even
        past a goal's own deadline — a known simplification, not a bug:
        properly stopping each goal's contribution at its own deadline
        would need per-goal period-by-period bookkeeping this function
        doesn't do; documented here rather than silently assumed correct.
      - irregular_income_by_offset: {0-indexed period offset: amount}, the
        user's own manual per-period estimates for uncertain income
      - seasonality_patterns: optional, from detect_seasonality()'s own
        `patterns` list — if given, scales "other variable spend" for any
        period whose calendar-month matches a detected pattern. Passing
        this is the ONLY way seasonality affects a forecast; it is never
        applied unless the caller explicitly opted in (see web_app.py's
        /forecast route — a checkbox the user must actively tick)."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    current_id = period.current_period_id(cursor, as_of_date)
    period_ids = [period.shift_period_id(current_id, i, start_day) for i in range(periods_ahead)]

    recurring_by_period = project_recurring_by_period(cursor, period_ids)
    flow = get_baseline_period_flow(cursor, as_of=as_of_date)
    reliable_income = get_reliable_monthly_income(cursor) or 0
    irregular_income_by_offset = irregular_income_by_offset or {}
    seasonality_patterns = seasonality_patterns or []
    seasonality_by_month = {p["month"]: p for p in seasonality_patterns}

    avg_recurring_out = (
        sum(v["out"] for v in recurring_by_period.values()) / len(period_ids) if period_ids else 0
    )
    base_other_variable_expense = max(flow["avg_expense"] - avg_recurring_out, 0)
    essential = get_average_period_essential_expense(cursor, as_of=as_of_date)

    balance = get_liquid_balance(cursor)
    results = []
    for i, pid in enumerate(period_ids):
        rec = recurring_by_period[pid]
        month = int(pid.split("-")[1])
        other_variable_expense = base_other_variable_expense
        pattern = seasonality_by_month.get(month)
        if pattern and pattern["overall_avg"]:
            other_variable_expense = round(base_other_variable_expense * (pattern["avg_expense"] / pattern["overall_avg"]))

        period_income = rec["in"] + reliable_income + irregular_income_by_offset.get(i, 0)
        period_expense = rec["out"] + other_variable_expense + goal_contribution_per_period
        balance = balance + period_income - period_expense
        is_danger = balance < 0 or (essential is not None and balance < essential)

        results.append({
            "period_index": i,
            "period_id": pid,
            "projected_balance": round(balance),
            "projected_income": round(period_income),
            "projected_expense": round(period_expense),
            "is_danger": is_danger,
        })

    return results


# ---------- Health-score dashboard (Mốc 5) ----------

HEALTH_LEVELS = ("nguy_hiem", "mong_manh", "on", "vung")  # worst to best, same order/labels as runway_months
BURN_RATE_DANGER_RATIO = 1.5


def get_total_net_worth(cursor):
    """Tổng tài sản = tổng số dư MỌI tài khoản đang hoạt động (không chỉ
    is_liquid — khác với get_liquid_balance, cái này trả lời "tổng tài sản
    tôi có", không phải "bao nhiêu dùng được ngay") + tổng giá trị
    investment_assets (Giai đoạn 7 — bảng luôn rỗng cho tới khi giai đoạn đó
    được xây, nên số hạng này chỉ là 0 hôm nay, nhưng phép cộng đã sẵn sàng
    không cần sửa lại khi Giai đoạn 7 có dữ liệu thật). Tuyệt đối KHÔNG dùng
    số này cho bất kỳ phép tính an toàn/thanh khoản nào (liquidity_risk,
    runway_months, short_term_forecast) — tài sản không lỏng (đầu tư, sổ
    tiết kiệm dài hạn) trộn vào đó sẽ khiến các chỉ số đó trông an toàn hơn
    thực tế, đúng loại lỗi nguy hiểm nhất cho một chỉ số an toàn."""
    cursor.execute("SELECT COALESCE(SUM(current_balance), 0) AS total FROM accounts WHERE is_active = 1")
    accounts_total = cursor.fetchone()["total"]
    cursor.execute("SELECT COALESCE(SUM(current_value), 0) AS total FROM investment_assets WHERE is_active = 1")
    investments_total = cursor.fetchone()["total"]
    return accounts_total + investments_total


def get_average_daily_total_spend(cursor, days=SPEND_LOOKBACK_DAYS, as_of=None):
    """Average daily 'out' spend from EVERY source (recurring included) over
    the trailing `days` — deliberately not the same as
    get_average_daily_variable_spend (which excludes recurring on purpose,
    for short_term_forecast's own math). "Số ngày cầm cự" wants the whole
    picture: recurring bills still consume cash and shorten how long you'd
    survive, so excluding them here would overstate survival time."""
    as_of_date = as_of or date.today()
    start_date = as_of_date - timedelta(days=days)
    cursor.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE direction = 'out' AND date(occurred_at) > ? AND date(occurred_at) <= ?""",
        (start_date.isoformat(), as_of_date.isoformat()),
    )
    return cursor.fetchone()["total"] / days


def get_survival_days(cursor, as_of=None):
    """Tài sản lỏng ÷ chi tiêu trung bình một ngày (mọi nguồn) — Mốc 5's
    own "số ngày cầm cự" component, expressed in days rather than
    runway_months' periods, using the full daily spend rate rather than
    just the essential-category average. None if there's no spending
    history to estimate a daily rate from."""
    daily_spend = get_average_daily_total_spend(cursor, as_of=as_of)
    if daily_spend <= 0:
        return None
    return get_liquid_balance(cursor) / daily_spend


def get_financial_rigidity(cursor, periods=ESSENTIAL_LOOKBACK_PERIODS, as_of=None):
    """Độ cứng tài chính = chi phí CỐ ĐỊNH (categories.stability = 'fixed' —
    the first real read of this column for anything beyond Mốc 1's budget-
    suggestion formula, which used it for a different purpose) ÷ thu nhập,
    trung bình `periods` kỳ gần nhất đã hoàn tất (not the in-progress
    current period, which would understate fixed costs not yet due this
    period — same "completed periods only" convention used throughout
    risk.py). Returns None if none of those periods had any income."""
    start_day = period.get_period_start_day(cursor)
    as_of_date = as_of or date.today()
    current_id = period.current_period_id(cursor, as_of_date)
    recent_ids = period.recent_period_ids_for(current_id, periods, start_day, include_current=False)

    total_fixed = 0
    total_income = 0
    for pid in recent_ids:
        p_start, p_end = period.period_bounds_for_id(pid, start_day)
        cursor.execute(
            """SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t
               JOIN categories c ON t.category_id = c.id
               WHERE t.direction = 'out' AND c.stability = 'fixed'
                 AND date(t.occurred_at) BETWEEN ? AND ?""",
            (p_start.isoformat(), p_end.isoformat()),
        )
        total_fixed += cursor.fetchone()["total"]
        cursor.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE direction = 'in' AND date(occurred_at) BETWEEN ? AND ?",
            (p_start.isoformat(), p_end.isoformat()),
        )
        total_income += cursor.fetchone()["total"]

    if total_income <= 0:
        return None
    return total_fixed / total_income * 100


def get_burn_rate_vs_elapsed(cursor, as_of=None):
    """Tốc độ đốt tiền = % tổng ngân sách (period_budgets) đã tiêu trong kỳ
    hiện tại so với % thời gian đã qua trong kỳ. ratio > 1 nghĩa là tiêu
    nhanh hơn tốc độ "đều" theo thời gian. has_data=False nếu chưa đặt ngân
    sách nào cho kỳ hiện tại — không có gì để so tốc độ đốt."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    period_id = period.current_period_id(cursor, as_of_date)
    statuses = get_period_budget_status(cursor, period_id)
    if not statuses:
        return {"has_data": False, "pct_used": None, "pct_elapsed": None, "ratio": None}

    total_budget = sum(s["amount"] for s in statuses)
    total_spent = sum(s["spent"] for s in statuses)
    pct_used = (total_spent / total_budget * 100) if total_budget else 0

    days_info = period.days_elapsed_and_remaining_for(as_of_date, start_day)
    pct_elapsed = days_info["elapsed_days"] / days_info["total_days"] * 100

    return {
        "has_data": True,
        "pct_used": pct_used,
        "pct_elapsed": pct_elapsed,
        "ratio": (pct_used / pct_elapsed) if pct_elapsed else None,
    }


def get_current_period_savings_rate(cursor, as_of=None):
    """(thu − chi) ÷ thu, tính trong PHẦN KỲ ĐÃ QUA của kỳ hiện tại (tới
    as_of, không phải toàn bộ kỳ vì kỳ hiện tại chưa kết thúc) — một chỉ số
    "hôm nay đang thế nào", khác với get_savings_rate_trend vốn chỉ nhìn
    các kỳ đã hoàn tất. None nếu chưa có thu nhập nào trong phần kỳ đã qua."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    period_id = period.current_period_id(cursor, as_of_date)
    period_start, _ = period.period_bounds_for_id(period_id, start_day)

    cursor.execute(
        """SELECT direction, COALESCE(SUM(amount), 0) AS total FROM transactions
           WHERE date(occurred_at) BETWEEN ? AND ?
           GROUP BY direction""",
        (period_start.isoformat(), as_of_date.isoformat()),
    )
    totals = {row["direction"]: row["total"] for row in cursor.fetchall()}
    income = totals.get("in", 0)
    expense = totals.get("out", 0)
    if income <= 0:
        return None
    return (income - expense) / income * 100


def get_spending_concentration(cursor, as_of=None):
    """Danh mục CHA nào (con cộng dồn vào cha, qua COALESCE(parent_id, id))
    chiếm % lớn nhất trong tổng chi của phần kỳ hiện tại đã qua. None nếu
    chưa có chi tiêu nào trong kỳ này."""
    as_of_date = as_of or date.today()
    start_day = period.get_period_start_day(cursor)
    period_id = period.current_period_id(cursor, as_of_date)
    period_start, _ = period.period_bounds_for_id(period_id, start_day)

    cursor.execute(
        """SELECT COALESCE(c.parent_id, c.id) AS top_category_id, SUM(t.amount) AS total
           FROM transactions t JOIN categories c ON t.category_id = c.id
           WHERE t.direction = 'out' AND date(t.occurred_at) BETWEEN ? AND ?
           GROUP BY top_category_id
           ORDER BY total DESC""",
        (period_start.isoformat(), as_of_date.isoformat()),
    )
    rows = cursor.fetchall()
    if not rows:
        return None

    total_expense = sum(r["total"] for r in rows)
    top = rows[0]
    cursor.execute("SELECT name_vi FROM categories WHERE id = ?", (top["top_category_id"],))
    name_row = cursor.fetchone()
    return {
        "category_name": name_row["name_vi"] if name_row else "?",
        "amount": top["total"],
        "pct_of_total": (top["total"] / total_expense * 100) if total_expense else 0,
    }


def get_income_stability(cursor, periods=SAVINGS_TREND_LOOKBACK_PERIODS, as_of=None):
    """Độ ổn định thu nhập = hệ số biến thiên (độ lệch chuẩn ÷ trung bình,
    tính bằng %) của thu nhập qua các kỳ đã hoàn tất — thấp hơn = ổn định
    hơn. Reuses get_savings_rate_trend's own period data rather than
    re-querying. None nếu chưa đủ 2 kỳ có thu nhập để so sánh (1 điểm dữ
    liệu không nói lên được gì về "biến động")."""
    trend = get_savings_rate_trend(cursor, periods=periods, as_of=as_of)
    incomes = [p["income"] for p in trend["periods"] if p["income"] > 0]
    if len(incomes) < 2:
        return None
    mean = sum(incomes) / len(incomes)
    if mean <= 0:
        return None
    return statistics.stdev(incomes) / mean * 100


def get_budget_streak(cursor, as_of=None, max_periods_checked=24):
    """Số kỳ liên tiếp (tính lùi từ kỳ gần nhất đã HOÀN TẤT — kỳ hiện tại
    đang chạy dở không tính) mà không danh mục nào trong period_budgets bị
    vượt hạn mức. Dừng đếm ở kỳ đầu tiên hoặc không có ngân sách nào được
    đặt (không phá chuỗi, chỉ là hết dữ liệu để nhìn xa hơn) hoặc bị vượt.
    has_data=False nếu kỳ gần nhất đã hoàn tất còn chưa từng đặt ngân sách
    (không có gì để bắt đầu đếm chuỗi)."""
    start_day = period.get_period_start_day(cursor)
    as_of_date = as_of or date.today()
    current_id = period.current_period_id(cursor, as_of_date)

    streak = 0
    has_data = False
    pid = period.shift_period_id(current_id, -1, start_day)
    for _ in range(max_periods_checked):
        statuses = get_period_budget_status(cursor, pid)
        if not statuses:
            break
        has_data = True
        if any(s["over_budget"] for s in statuses):
            break
        streak += 1
        pid = period.shift_period_id(pid, -1, start_day)

    return {"has_data": has_data, "streak": streak}


def get_health_score(cursor, as_of=None):
    """Mốc 5's headline number: MỘT chỉ số sức khỏe tổng hợp, dựa trên
    runway_months() (chỉ số quan trọng nhất theo THIET-KE.md 4.3) làm nền,
    chỉ HẠ THẤP thêm (không bao giờ nâng lên) khi có tín hiệu cấp bách hơn:
      - hạ 1 bậc nếu short_term_forecast() báo at_risk (nguy cơ âm quỹ
        NGAY kỳ này — cấp bách hơn một con số runway dài hạn)
      - hạ 1 bậc nếu tốc độ đốt tiền > BURN_RATE_DANGER_RATIO lần tốc độ
        "đều" theo thời gian đã qua trong kỳ
    Không có tín hiệu nào được phép NÂNG bậc — chỉ runway_months (dữ liệu
    dài hạn nhất, ổn định nhất) mới được nói "vững", giữ tinh thần thận
    trọng hơn là lạc quan quá mức (Loss Aversion, THIET-KE.md 7.2) khi hai
    chỉ số có vẻ mâu thuẫn nhau.

    Returns {"level": ...|None, "has_data": bool, "downgraded_reasons": [...]}."""
    runway = runway_months(cursor)
    if runway["level"] is None:
        return {"level": None, "has_data": False, "downgraded_reasons": []}

    level_index = HEALTH_LEVELS.index(runway["level"])
    reasons = []

    forecast = short_term_forecast(cursor, as_of=as_of)
    if forecast["at_risk"] and level_index > 0:
        level_index -= 1
        reasons.append("Dự báo cuối kỳ có thể âm quỹ")

    burn = get_burn_rate_vs_elapsed(cursor, as_of=as_of)
    if burn["has_data"] and burn["ratio"] is not None and burn["ratio"] > BURN_RATE_DANGER_RATIO and level_index > 0:
        level_index -= 1
        reasons.append("Tốc độ chi tiêu nhanh hơn nhiều so với tiến độ kỳ")

    return {"level": HEALTH_LEVELS[level_index], "has_data": True, "downgraded_reasons": reasons}
