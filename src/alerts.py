"""Turns risk.py's numbers into user-facing warnings — the "Phòng ngừa"
(Guarding) pillar from THIET-KE.md Part 1.3: proactive alerts instead of
making the user go check /risk themselves. Also the first real writer for
the `alert_shown` behavior event (THIET-KE.md Part 5's Nudge/Loss-Aversion
tracking — only `category_overridden` had a writer before this)."""

import risk
from transaction import log_behavior_event


def get_active_alerts(cursor, as_of=None):
    """Read-only: returns a list of {"code", "level" ("danger"/"warning"),
    "message"} for risk conditions worth surfacing right now. Doesn't log
    anything — call log_shown_alerts() separately once these are actually
    displayed to the user."""
    alerts = []

    forecast = risk.short_term_forecast(cursor, as_of=as_of)
    if forecast["at_risk"]:
        alerts.append({
            "code": "short_term_forecast_negative",
            "level": "danger",
            "message": f"⚠️ Dự báo cuối kỳ có thể âm quỹ: {forecast['forecast_balance']:,} đ. Cân nhắc giảm chi tiêu.",
        })

    liquidity = risk.liquidity_risk(cursor)
    if liquidity["sufficient"] is False:
        alerts.append({
            "code": "liquidity_insufficient",
            "level": "warning",
            "message": "Tài sản lỏng hiện không đủ trang trải 1 kỳ chi phí thiết yếu.",
        })

    runway = risk.runway_months(cursor)
    if runway["level"] == "nguy_hiem":
        alerts.append({
            "code": "runway_danger",
            "level": "danger",
            "message": f"Nền móng tài chính nguy hiểm: chỉ đủ sống {runway['months']:.1f} kỳ nếu mất thu nhập.",
        })
    elif runway["level"] == "mong_manh":
        alerts.append({
            "code": "runway_fragile",
            "level": "warning",
            "message": f"Nền móng tài chính mong manh: đủ sống {runway['months']:.1f} kỳ nếu mất thu nhập.",
        })

    margin = risk.income_sustainability_margin(cursor)
    if margin["has_data"] and not margin["sufficient"]:
        alerts.append({
            "code": "income_sustainability_insufficient",
            "level": "warning",
            "message": f"Thu nhập ổn định thấp hơn chi phí thiết yếu mỗi kỳ (chênh lệch {margin['margin']:,.0f} đ).",
        })

    return alerts


def log_shown_alerts(cursor, alerts):
    for alert in alerts:
        log_behavior_event(cursor, "alert_shown", payload={"code": alert["code"], "level": alert["level"]})
