"""Custom financial-period math (default: 15th of this month through the 14th
of next month, configurable via app_settings.period_start_day). Every place
in this app that used to reason in calendar months (risk.py's metrics,
budgets, the savings-rate trend, ...) reasons in these periods instead — a
period is not a calendar month, even though its id is formatted like one.

Deliberately has no dependency on transaction.py or risk.py (this module is a
leaf, imported by both) — its own tiny _add_months below duplicates
transaction.py's day-clamping convention on purpose rather than importing it,
to keep the dependency direction one-way and avoid a cycle."""

import calendar
from datetime import date, timedelta

DEFAULT_PERIOD_START_DAY = 15


def _add_months(d, months):
    """Same day-clamping convention as transaction.py's _add_months: shifting
    a date with day=31 into a 30-day month clamps to that month's last day."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def get_period_start_day(cursor):
    """Reads the configured period-start day (1-31), falling back to the
    default if app_settings has no row yet (e.g. right after migrating,
    before the seed INSERT OR IGNORE has had a chance to run, or in a
    from-scratch test DB)."""
    cursor.execute("SELECT value FROM app_settings WHERE key = 'period_start_day'")
    row = cursor.fetchone()
    return int(row["value"]) if row else DEFAULT_PERIOD_START_DAY


def set_period_start_day(cursor, day):
    if not isinstance(day, int) or not (1 <= day <= 31):
        raise ValueError("Ngày bắt đầu kỳ phải là số nguyên trong khoảng 1-31.")
    cursor.execute(
        """INSERT INTO app_settings (key, value) VALUES ('period_start_day', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value""",
        (str(day),),
    )


def period_bounds(d, start_day):
    """(start_date, end_date), both inclusive, of the period containing `d`.
    A period starting on `start_day` of month M runs through the day before
    `start_day` of month M+1 — e.g. start_day=15: 2026-07-15 .. 2026-08-14."""
    clamped_this_month = min(start_day, calendar.monthrange(d.year, d.month)[1])
    if d.day >= clamped_this_month:
        period_start = date(d.year, d.month, clamped_this_month)
    else:
        prev_month_first = _add_months(date(d.year, d.month, 1), -1)
        clamped_prev_month = min(start_day, calendar.monthrange(prev_month_first.year, prev_month_first.month)[1])
        period_start = date(prev_month_first.year, prev_month_first.month, clamped_prev_month)
    period_end = _add_months(period_start, 1) - timedelta(days=1)
    return period_start, period_end


def period_id_for(d, start_day):
    """'YYYY-MM' of the period's *start* date — looks like a calendar month
    string but isn't one once start_day != 1. Sorts lexicographically like
    the old calendar-month ids, which is the only property callers rely on."""
    period_start, _ = period_bounds(d, start_day)
    return period_start.strftime("%Y-%m")


def period_bounds_for_id(period_id_str, start_day):
    """Inverse of period_id_for — (start_date, end_date) for a given id,
    past, current, or future."""
    year, month = (int(part) for part in period_id_str.split("-"))
    clamped_day = min(start_day, calendar.monthrange(year, month)[1])
    period_start = date(year, month, clamped_day)
    period_end = _add_months(period_start, 1) - timedelta(days=1)
    return period_start, period_end


def shift_period_id(period_id_str, n, start_day):
    """The period id n periods after (n>0) or before (n<0) the given one."""
    period_start, _ = period_bounds_for_id(period_id_str, start_day)
    shifted_start = _add_months(period_start, n)
    return shifted_start.strftime("%Y-%m")


def current_period_id(cursor, as_of=None):
    start_day = get_period_start_day(cursor)
    return period_id_for(as_of or date.today(), start_day)


def recent_period_ids_for(current_id, n, start_day, include_current=False):
    """Pure version of recent_period_ids — takes the current period id and
    start_day directly so it's testable without a DB cursor."""
    offsets = range(0, -n, -1) if include_current else range(-1, -n - 1, -1)
    ids = [shift_period_id(current_id, offset, start_day) for offset in offsets]
    return list(reversed(ids))


def recent_period_ids(cursor, n, as_of=None, include_current=False):
    """Last n period ids, oldest-first — matches the shape callers actually
    loop over. include_current=False (the default) excludes the still-open
    current period, same convention risk.py already used for calendar
    months (a partial period shouldn't skew an average low)."""
    start_day = get_period_start_day(cursor)
    current_id = current_period_id(cursor, as_of)
    return recent_period_ids_for(current_id, n, start_day, include_current=include_current)


def days_elapsed_and_remaining_for(d, start_day):
    """Pure version of days_elapsed_and_remaining — takes a date and
    start_day directly so it's testable without a DB cursor. Both
    elapsed/remaining count `d` itself as an elapsed day, so
    elapsed + remaining == total."""
    period_start, period_end = period_bounds(d, start_day)
    total = (period_end - period_start).days + 1
    elapsed = (d - period_start).days + 1
    return {
        "period_start": period_start,
        "period_end": period_end,
        "total_days": total,
        "elapsed_days": elapsed,
        "remaining_days": total - elapsed,
    }


def days_elapsed_and_remaining(cursor, as_of=None):
    """For 'burn rate' style metrics (% of period elapsed vs. % of budget
    used) — Milestone 5."""
    start_day = get_period_start_day(cursor)
    d = as_of or date.today()
    return days_elapsed_and_remaining_for(d, start_day)
