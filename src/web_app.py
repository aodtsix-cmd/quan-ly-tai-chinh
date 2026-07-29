import csv
import io
import json
import os
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, redirect, render_template_string, request, session, url_for
from pydantic import BaseModel, Field

# Must run before any os.environ.get() below — lets APP_PASSWORD/GEMINI_API_KEY/etc.
# come from a local .env file instead of always needing to be exported by hand.
# A real shell-exported env var still wins over .env (load_dotenv's default), so
# existing deployments that already export these directly are unaffected.
load_dotenv()

import alerts
import period
import risk
from ocr_import import analyze_image, make_external_ref
from services.ai_client import DEFAULT_MODEL_HEAVY, get_ai_suggestion, get_macro_context
from transaction import (
    add_event_plan_item,
    add_forecast_period,
    add_rule,
    add_simulation_scenario,
    apply_matching_rule,
    connect_db,
    create_cashflow_forecast,
    create_event_plan,
    create_goal,
    deactivate_goal,
    create_spending_simulation,
    delete_rule,
    delete_transaction,
    dismiss_event_plan_goal_prompt,
    generate_due_recurring,
    get_active_accounts,
    get_all_transactions_for_export,
    get_cashflow_forecast_by_id,
    get_cashflow_forecasts,
    get_categories,
    get_event_plan_by_id,
    get_event_plan_items,
    get_event_plans,
    get_event_template_items,
    get_event_templates,
    get_forecast_periods,
    get_goal_by_id,
    get_goals,
    get_monthly_totals,
    get_period_budgets,
    get_recent_transactions,
    get_rules,
    get_simulation_scenarios,
    get_spending_simulation_by_id,
    get_spending_simulations,
    get_transaction_by_id,
    insert_transaction,
    insert_transfer,
    link_event_plan_to_goal,
    log_behavior_event,
    parse_amount_vnd,
    resolve_category,
    set_period_budget,
    set_simulation_ai_recommendation,
    update_transaction_category,
)

app = Flask(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"


class BudgetAdjustment(BaseModel):
    category_id: int
    suggested_amount: int = Field(
        description="Số tiền đề xuất cho danh mục này, VNĐ nguyên. Có thể giữ nguyên "
        "số ở gợi ý công thức nếu hợp lý, hoặc đề xuất số khác nếu thấy cần."
    )
    reason: str = Field(description="Lý do ngắn gọn, 1 câu, tiếng Việt.")


class BudgetSuggestionResult(BaseModel):
    adjustments: list[BudgetAdjustment]
    summary: str = Field(description="Nhận xét tổng quan ngắn gọn, 1-2 câu, tiếng Việt.")


class GoalPriorityItem(BaseModel):
    goal_id: int
    priority_rank: int = Field(description="Thứ tự ưu tiên, 1 = nên ưu tiên nhất.")
    reason: str = Field(description="Lý do ngắn gọn, 1 câu, tiếng Việt.")


class GoalPriorityResult(BaseModel):
    priorities: list[GoalPriorityItem]
    summary: str = Field(
        description="Nhận xét tổng quan 1-2 câu, tiếng Việt, có thể đề xuất giãn hạn nếu cần."
    )


GOAL_TYPE_LABELS = {
    "emergency_fund": "Quỹ khẩn cấp",
    "savings": "Tiết kiệm mục tiêu",
    "investment": "Đầu tư",
    "medical": "Dự phòng y tế",
    "custom": "Khác",
}


class ScenarioProsCons(BaseModel):
    scenario_label: str = Field(description="Nhãn phương án, đúng như đã cho trong dữ liệu, ví dụ 'Trả thẳng' hoặc 'Trả góp 6 kỳ'.")
    pros: str = Field(description="Mặt được, 1 câu, tiếng Việt.")
    cons: str = Field(description="Mặt mất, 1 câu, tiếng Việt.")


class SpendingSimulationAdvice(BaseModel):
    scenario_notes: list[ScenarioProsCons]
    recommendation: str = Field(description="Khuyến nghị rõ ràng, 2-3 câu, kèm lý do, tiếng Việt.")
    summary: str = Field(description="Nhận xét tổng quan 1-2 câu, tiếng Việt.")


def scenario_label(scenario):
    if scenario["scenario_type"] == "pay_now":
        return "Trả thẳng"
    if scenario["scenario_type"] == "installments":
        return f"Trả góp {scenario['installment_periods']} kỳ"
    if scenario["scenario_type"] == "delay":
        return f"Hoãn {scenario['delay_periods']} kỳ"
    return scenario["scenario_type"]


TRAFFIC_LIGHT_LABELS = {"green": "An toàn", "yellow": "Cân nhắc", "red": "Rủi ro"}
TRAFFIC_LIGHT_COLORS = {"green": "bg-emerald-100 text-emerald-700", "yellow": "bg-amber-100 text-amber-700", "red": "bg-rose-100 text-rose-700"}


class DailySummaryResult(BaseModel):
    summary: str = Field(description="Nhận xét ngắn gọn 2-3 câu, tiếng Việt, về tình hình tài chính hôm nay.")


APP_PASSWORD = os.environ.get("APP_PASSWORD")
if not APP_PASSWORD:
    raise RuntimeError(
        "Chưa đặt biến môi trường APP_PASSWORD. "
        "Chạy ví dụ: APP_PASSWORD=matma_cua_ban python3 src/web_app.py"
    )

app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32)
app.permanent_session_lifetime = timedelta(days=30)

# Mốc 4's macro-context layer (Gemini + Google Search grounding) is the most
# expensive/slowest/least deterministic AI feature in this app — off by
# default per the user's own explicit requirement ("tách riêng, tùy chọn,
# tắt được"). Set ENABLE_MACRO_CONTEXT=1 to show the "Bối cảnh tham khảo"
# section on /forecast at all; even when enabled, it's still click-triggered
# only, never auto-loaded.
ENABLE_MACRO_CONTEXT = os.environ.get("ENABLE_MACRO_CONTEXT") == "1"


@app.before_request
def require_login():
    if request.endpoint in ("login", "static"):
        return
    if not session.get("authenticated"):
        if request.path.startswith("/api/"):
            return jsonify(ok=False, message="Phiên đăng nhập hết hạn, vui lòng tải lại trang."), 401
        return redirect(url_for("login"))

    # Catch up on any due recurring transactions on every authenticated request —
    # cheap no-op when nothing is due (see transaction.generate_due_recurring).
    conn = connect_db()
    cursor = conn.cursor()
    generate_due_recurring(cursor)
    conn.commit()
    conn.close()


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if request.form.get("password") == APP_PASSWORD:
            session.permanent = True
            session["authenticated"] = True
            return redirect(url_for("dashboard"))
        error = "Mã không đúng, thử lại."
    return render_template_string(LOGIN_TEMPLATE, error=error)


def accounts_as_json(cursor):
    return [
        {"id": row["id"], "name": row["name"], "balance": row["current_balance"]}
        for row in get_active_accounts(cursor)
    ]


def category_tree_as_json(cursor, kind):
    """Group get_categories() rows into [{id, name, children: [...]}, ...]."""
    rows = get_categories(cursor, kind)

    parents = []
    children_by_parent = {}
    for row in rows:
        if row["parent_id"] is None:
            parents.append({"id": row["id"], "name": row["name_vi"], "children": []})
        else:
            children_by_parent.setdefault(row["parent_id"], []).append(
                {"id": row["id"], "name": row["name_vi"]}
            )

    for parent in parents:
        parent["children"] = children_by_parent.get(parent["id"], [])

    return parents


@app.route("/")
def dashboard():
    """Mốc 5's health-score dashboard — the new home page, replacing what
    used to be the add-transaction form at "/" (that form now lives at
    /add, see add_transaction_page below). This is "the first thing I look
    at every day" per the user's own stated daily habit loop (see balance →
    know where I stand → enter today's transaction → see the plan) — so
    proactive alerts moved here too (from the old index()), since this is
    now the real "moment the app opens", not /add."""
    conn = connect_db()
    cursor = conn.cursor()

    active_alerts = alerts.get_active_alerts(cursor)
    if active_alerts:
        alerts.log_shown_alerts(cursor, active_alerts)
        conn.commit()

    health = risk.get_health_score(cursor)
    net_worth = risk.get_total_net_worth(cursor)
    survival_days = risk.get_survival_days(cursor)
    rigidity = risk.get_financial_rigidity(cursor)
    burn = risk.get_burn_rate_vs_elapsed(cursor)
    savings_rate = risk.get_current_period_savings_rate(cursor)
    concentration = risk.get_spending_concentration(cursor)
    income_stability = risk.get_income_stability(cursor)
    budget_streak = risk.get_budget_streak(cursor)

    period_id = period.current_period_id(cursor)
    days_info = period.days_elapsed_and_remaining(cursor)
    budget_statuses = risk.get_period_budget_status(cursor, period_id)

    # Goals/events existed as full features since Mốc 2 but were never once
    # referenced from the dashboard that later became the app's home page —
    # a real interconnection gap: the page you look at every day said
    # nothing about either. Both sections below are read-only summaries
    # (goals/events pages remain the actual CRUD surface) built from the
    # same shared helpers api_ai_daily_summary() uses, so the dashboard
    # card and the AI's synthesis always agree with each other.
    goals_status = _goals_status_summary(cursor)
    goals_summary = None
    if goals_status["total"] > 0:
        most_urgent = None
        if goals_status["off_track"]:
            g = goals_status["off_track"][0]
            reason = "đã quá hạn" if g["reason"] == "overdue" else "đang chậm tiến độ"
            most_urgent = {"message": f"{g['name']}: {reason}, còn thiếu {g['remaining_amount']:,} đ"}
        goals_summary = {
            "total": goals_status["total"],
            "on_track_count": goals_status["on_track_count"],
            "most_urgent": most_urgent,
        }

    nearest_event_raw = _nearest_upcoming_event(cursor)
    nearest_event = None
    if nearest_event_raw:
        nearest_event = dict(nearest_event_raw, total_display=f"{nearest_event_raw['total_expected']:,} đ")

    # Proactive reminders (THIET-KE.md 1.3's "Phòng ngừa" pillar again, this
    # time about the ENVELOPE budgets rather than the whole-account alerts
    # above): most-used-first, top 3 — over-budget categories get a plainer
    # "already over" message instead of a remaining-amount one.
    reminders = []
    for s in sorted(budget_statuses, key=lambda row: -row["pct_used"])[:3]:
        if s["over_budget"]:
            reminders.append(f"Đã vượt ngân sách {s['category_name']}: {s['spent']:,} đ / {s['amount']:,} đ.")
        else:
            reminders.append(
                f"Còn {s['remaining']:,} đ cho {s['category_name']} trong "
                f"{days_info['remaining_days']} ngày còn lại của kỳ."
            )

    conn.close()

    return render_template_string(
        DASHBOARD_TEMPLATE,
        alerts=active_alerts,
        health={
            "has_data": health["has_data"],
            "level": health["level"],
            "level_label": RUNWAY_LEVEL_LABELS.get(health["level"], "Chưa đủ dữ liệu"),
            "color": HEALTH_LEVEL_COLORS.get(health["level"], "bg-slate-300"),
            "downgraded_reasons": health["downgraded_reasons"],
        },
        net_worth_display=f"{net_worth:,} đ",
        period_id=period_id,
        days_remaining=days_info["remaining_days"],
        reminders=reminders,
        goals_summary=goals_summary,
        nearest_event=nearest_event,
        metrics=[
            {
                "label": "Số ngày cầm cự",
                "value": f"{survival_days:,.0f} ngày" if survival_days is not None else "Chưa đủ dữ liệu",
                "hint": "Tài sản lỏng chia cho chi tiêu trung bình mỗi ngày.",
            },
            {
                "label": "Độ cứng tài chính",
                "value": f"{rigidity:.0f}% thu nhập" if rigidity is not None else "Chưa đủ dữ liệu",
                "hint": "Chi phí cố định (nhà, trả góp, ...) chiếm bao nhiêu % thu nhập.",
            },
            {
                "label": "Tốc độ đốt tiền",
                "value": (
                    f"{burn['pct_used']:.0f}% ngân sách / {burn['pct_elapsed']:.0f}% kỳ đã qua"
                    if burn["has_data"] else "Chưa đặt ngân sách kỳ này"
                ),
                "hint": "So tốc độ tiêu ngân sách với tốc độ thời gian trôi qua trong kỳ.",
            },
            {
                "label": "Tỉ lệ tiết kiệm (kỳ này, tới hôm nay)",
                "value": f"{savings_rate:.0f}%" if savings_rate is not None else "Chưa có thu nhập kỳ này",
                "hint": "(Thu − chi) ÷ thu, tính từ đầu kỳ tới hôm nay.",
            },
            {
                "label": "Độ tập trung chi tiêu",
                "value": (
                    f"{concentration['category_name']} ({concentration['pct_of_total']:.0f}%)"
                    if concentration is not None else "Chưa có chi tiêu kỳ này"
                ),
                "hint": "Danh mục lớn nhất đang chiếm bao nhiêu % tổng chi kỳ này.",
            },
            {
                "label": "Độ ổn định thu nhập",
                "value": f"{income_stability:.0f}% biến thiên" if income_stability is not None else "Chưa đủ dữ liệu",
                "hint": "Độ lệch chuẩn thu nhập giữa các kỳ — thấp hơn là ổn định hơn.",
            },
            {
                "label": "Chuỗi kỳ đạt ngân sách",
                "value": f"{budget_streak['streak']} kỳ liên tiếp" if budget_streak["has_data"] else "Chưa có dữ liệu",
                "hint": "Số kỳ liên tiếp gần nhất không danh mục nào vượt ngân sách.",
            },
        ],
    )


@app.route("/add")
def add_transaction_page():
    conn = connect_db()
    cursor = conn.cursor()
    accounts = accounts_as_json(cursor)
    categories_by_kind = {
        "expense": category_tree_as_json(cursor, "expense"),
        "income": category_tree_as_json(cursor, "income"),
    }
    conn.close()
    return render_template_string(
        PAGE_TEMPLATE, accounts=accounts, categories_by_kind=categories_by_kind
    )


@app.route("/alerts/<code>/dismiss", methods=["POST"])
def dismiss_alert(code):
    conn = connect_db()
    cursor = conn.cursor()
    log_behavior_event(cursor, "alert_acted_on", payload={"code": code})
    conn.commit()
    conn.close()
    return redirect(url_for("dashboard"))


@app.route("/api/ai/daily-summary")
def api_ai_daily_summary():
    conn = connect_db()
    cursor = conn.cursor()

    health = risk.get_health_score(cursor)
    if not health["has_data"]:
        conn.close()
        return jsonify({"available": False, "reason": "no_data", "data": None})

    period_id = period.current_period_id(cursor)
    budget_statuses = risk.get_period_budget_status(cursor, period_id)

    # Deep AI integration (Mốc 5 originally only handed this task the health
    # score + net worth + a few risk.py metrics — every other feature was
    # invisible to it, so the "daily summary" couldn't actually reflect the
    # user's full financial picture). Now synthesizes across every major
    # feature in one call: risk metrics, envelope budgets, goals, AND
    # upcoming event plans — still just more Python-computed facts handed
    # to the prompt, never a new number the AI itself works out.
    goals_status = _goals_status_summary(cursor)
    nearest_event = _nearest_upcoming_event(cursor)

    data = {
        "date": date.today().isoformat(),
        "health_level": health["level"],
        "health_downgraded_reasons": health["downgraded_reasons"],
        "net_worth": risk.get_total_net_worth(cursor),
        "survival_days": risk.get_survival_days(cursor),
        "financial_rigidity_pct": risk.get_financial_rigidity(cursor),
        "current_period_savings_rate_pct": risk.get_current_period_savings_rate(cursor),
        "budget_categories_over_limit": [s["category_name"] for s in budget_statuses if s["over_budget"]],
        "goals_total": goals_status["total"],
        "goals_on_track_count": goals_status["on_track_count"],
        "goals_off_track": goals_status["off_track"],
        "nearest_event": nearest_event,
    }

    prompt_template = (PROMPTS_DIR / "daily_summary.md").read_text(encoding="utf-8")
    prompt = prompt_template.format(data_json=json.dumps(data, ensure_ascii=False))

    # `date` inside input_data naturally busts the cache once a day (a new
    # hash every calendar day) — ttl_seconds is just a backstop, not the
    # actual mechanism keeping this to one real call/day.
    result = get_ai_suggestion(
        cursor, task="daily_summary", input_data=data,
        response_schema=DailySummaryResult, prompt=prompt,
        ttl_seconds=24 * 60 * 60,
    )
    conn.commit()
    conn.close()
    return jsonify(result)


@app.route("/transactions")
def transactions_page():
    conn = connect_db()
    cursor = conn.cursor()
    # Was a hardcoded limit=50 with no way at all to see anything older —
    # a real dead end for an app people are expected to keep using for
    # months. "Xem thêm" just re-requests with a bigger limit each time
    # (peeking one extra row to know whether there's still more beyond it),
    # rather than building out real pagination/search, which is a bigger,
    # not-yet-requested feature.
    limit = request.args.get("limit", 50, type=int) or 50
    limit = max(10, min(limit, 1000))
    rows = get_recent_transactions(cursor, limit=limit + 1)
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]

    transactions = []
    for row in rows:
        sign = "+" if row["direction"] == "in" else "-"
        transactions.append({
            "id": row["id"],
            "occurred_at": row["occurred_at"],
            "amount_display": f"{sign}{row['amount']:,} đ",
            "sign_class": "in" if row["direction"] == "in" else "out",
            "category_name": row["category_name"] or "(chưa phân loại)",
            "account_name": row["account_name"],
            "description": row["description"] or "",
        })

    # /import/confirm redirects here with these three counts so the user
    # actually sees what happened to their upload — previously tracked
    # server-side and then silently discarded, no confirmation shown at all.
    import_saved = request.args.get("import_saved", type=int)
    import_summary = None
    if import_saved is not None:
        skipped_dup = request.args.get("import_skipped_duplicate", 0, type=int)
        skipped_invalid = request.args.get("import_skipped_invalid", 0, type=int)
        parts = [f"Đã lưu {import_saved} giao dịch từ ảnh"]
        if skipped_dup:
            parts.append(f"{skipped_dup} trùng lặp đã bỏ qua")
        if skipped_invalid:
            parts.append(f"{skipped_invalid} không hợp lệ đã bỏ qua")
        import_summary = ", ".join(parts) + "."

    return render_template_string(
        LIST_TEMPLATE, transactions=transactions, has_more=has_more, next_limit=limit + 50,
        import_summary=import_summary,
    )


@app.route("/transactions/export.csv")
def export_transactions_csv():
    """The only way out of this app for a user's own data besides copying
    the raw SQLite file by hand — real portability/backup, not an internal
    display feature. Every transaction, not just what's shown on
    /transactions (which is paginated)."""
    conn = connect_db()
    cursor = conn.cursor()
    rows = get_all_transactions_for_export(cursor)
    conn.close()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["occurred_at", "amount", "direction", "account", "category", "description", "source"])
    for row in rows:
        writer.writerow([
            row["occurred_at"], row["amount"], row["direction"], row["account_name"],
            row["category_name"] or "", row["description"] or "", row["source"],
        ])

    filename = f"giao-dich-{date.today().isoformat()}.csv"
    # UTF-8 BOM prefix: without it, Excel on Windows (a very plausible CSV
    # consumer for this user) renders Vietnamese diacritics as mojibake —
    # every other consumer (text editors, Google Sheets, Numbers) tolerates
    # or ignores a leading BOM, so this is a pure compatibility improvement.
    return Response(
        "﻿" + buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.route("/transactions/<int:transaction_id>/delete", methods=["POST"])
def delete_transaction_route(transaction_id):
    conn = connect_db()
    cursor = conn.cursor()
    delete_transaction(cursor, transaction_id)
    conn.commit()
    conn.close()
    return redirect(url_for("transactions_page"))


@app.route("/transactions/<int:transaction_id>/edit", methods=["GET", "POST"])
def edit_transaction_page(transaction_id):
    conn = connect_db()
    cursor = conn.cursor()
    tx = get_transaction_by_id(cursor, transaction_id)
    if tx is None:
        conn.close()
        return "Không tìm thấy giao dịch.", 404

    if request.method == "POST":
        category_id_raw = request.form.get("category_id")
        new_category_id = int(category_id_raw) if category_id_raw else None
        old_category_id = tx["category_id"]

        update_transaction_category(cursor, transaction_id, new_category_id)
        log_behavior_event(
            cursor, "category_overridden", transaction_id=transaction_id,
            payload={"old_category_id": old_category_id, "new_category_id": new_category_id},
        )
        log_behavior_event(cursor, "transaction_reviewed", transaction_id=transaction_id)

        if new_category_id is not None and request.form.get("create_rule"):
            pattern = (request.form.get("pattern") or "").strip()
            if pattern:
                add_rule(cursor, pattern=pattern, category_id=new_category_id, created_from="learned")

        conn.commit()
        conn.close()
        return redirect(url_for("transactions_page"))

    kind = "expense" if tx["direction"] == "out" else "income"
    categories = category_tree_as_json(cursor, kind)
    conn.close()

    sign = "+" if tx["direction"] == "in" else "-"
    return render_template_string(
        EDIT_TEMPLATE,
        tx={
            "id": tx["id"],
            "occurred_at": tx["occurred_at"],
            "amount_display": f"{sign}{tx['amount']:,} đ",
            "account_name": tx["account_name"],
            "description": tx["description"] or "",
            "category_id": tx["category_id"],
        },
        categories=categories,
    )


@app.route("/summary")
def summary_page():
    month = datetime.now().strftime("%Y-%m")
    conn = connect_db()
    cursor = conn.cursor()
    totals = get_monthly_totals(cursor, month)
    accounts = get_active_accounts(cursor)
    conn.close()

    diff = totals["income"] - totals["expense"]

    return render_template_string(
        SUMMARY_TEMPLATE,
        month_display=datetime.now().strftime("%m/%Y"),
        income_display=f"{totals['income']:,} đ",
        expense_display=f"{totals['expense']:,} đ",
        diff_display=f"{diff:,} đ",
        diff_positive=diff >= 0,
        accounts=[
            {"name": a["name"], "balance_display": f"{a['current_balance']:,} đ"}
            for a in accounts
        ],
    )


@app.route("/rules")
def rules_page():
    conn = connect_db()
    cursor = conn.cursor()
    rows = get_rules(cursor)
    conn.close()

    rules = [
        {
            "id": r["id"],
            "pattern": r["pattern"],
            "category_name": r["category_name"],
            "priority": r["priority"],
            "hit_count": r["hit_count"],
            "created_from": r["created_from"],
        }
        for r in rows
    ]
    return render_template_string(RULES_TEMPLATE, rules=rules)


@app.route("/rules/<int:rule_id>/delete", methods=["POST"])
def delete_rule_route(rule_id):
    conn = connect_db()
    cursor = conn.cursor()
    delete_rule(cursor, rule_id)
    conn.commit()
    conn.close()
    return redirect(url_for("rules_page"))


def _flatten_categories(categories_by_parent):
    """[{id, name, children:[...]}] -> flat [{id, name}], child names prefixed
    with their parent's for context (e.g. "Ăn uống › Cà phê/Trà sữa")."""
    flat = []
    for parent in categories_by_parent:
        if parent["children"]:
            for child in parent["children"]:
                flat.append({"id": child["id"], "name": f"{parent['name']} › {child['name']}"})
        else:
            flat.append({"id": parent["id"], "name": parent["name"]})
    return flat


@app.route("/budgets")
def budgets_page():
    conn = connect_db()
    cursor = conn.cursor()

    start_day = period.get_period_start_day(cursor)
    period_id = request.args.get("period") or period.current_period_id(cursor)
    prev_period = period.shift_period_id(period_id, -1, start_day)
    next_period = period.shift_period_id(period_id, 1, start_day)
    period_start, period_end = period.period_bounds_for_id(period_id, start_day)

    existing_by_category = {b["category_id"]: b for b in get_period_budgets(cursor, period_id)}
    suggestions = risk.suggest_period_budget_amounts(cursor, period_id)
    status_by_category = {s["category_id"]: s for s in risk.get_period_budget_status(cursor, period_id)}
    categories = _flatten_categories(category_tree_as_json(cursor, "expense"))
    # Cross-references goals ↔ budgets (previously two entirely separate
    # features that never referenced each other): purely informational —
    # doesn't fold into or validate the budget numbers, just lets the user
    # visually check whether what they're about to budget still leaves room
    # for what their goals need each period.
    goal_contribution_per_period = _total_goal_contribution_per_period(cursor)

    conn.close()

    rows = []
    for cat in categories:
        cat_id = cat["id"]
        existing = existing_by_category.get(cat_id)
        suggestion = suggestions.get(cat_id)
        status = status_by_category.get(cat_id)
        amount = existing["amount"] if existing else (suggestion["amount"] if suggestion else None)
        raw_pct = status["pct_used"] if status else 0
        if raw_pct > 100:
            bar_color = "bg-rose-500"
        elif raw_pct >= 70:
            bar_color = "bg-amber-500"
        else:
            bar_color = "bg-emerald-500"
        rows.append({
            "id": cat_id,
            "name": cat["name"],
            "amount_value": amount or "",
            "is_suggestion": existing is None and suggestion is not None,
            "has_budget": status is not None,
            "spent_display": f"{status['spent']:,} đ" if status else "",
            "pct_used": min(raw_pct, 100),
            "bar_color": bar_color,
            "over_budget": status["over_budget"] if status else False,
        })

    total_budgeted = sum(r["amount_value"] for r in rows if r["amount_value"])

    return render_template_string(
        BUDGETS_TEMPLATE,
        period_id=period_id,
        prev_period=prev_period,
        next_period=next_period,
        period_range_display=f"{period_start.strftime('%d/%m')} – {period_end.strftime('%d/%m/%Y')}",
        rows=rows,
        error=request.args.get("error"),
        goal_contribution_display=(
            f"{goal_contribution_per_period:,} đ" if goal_contribution_per_period > 0 else None
        ),
        total_budgeted_display=f"{total_budgeted:,} đ",
    )


@app.route("/budgets/save", methods=["POST"])
def budgets_save():
    period_id = request.form.get("period_id")
    conn = connect_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id, name_vi FROM categories WHERE kind = 'expense'")
    category_names_by_id = {row["id"]: row["name_vi"] for row in cursor.fetchall()}

    # Blank fields are expected (not every category gets a budget every
    # period) and skipped silently — but a NON-blank amount that fails to
    # parse (e.g. "500k" typed where the field used to require bare digits)
    # is a real mistake, confirmed live to previously vanish with zero
    # feedback: the category was just silently left unsaved, indistinguishable
    # from the user never having touched that field at all.
    failed_category_names = []
    for key, raw_value in request.form.items():
        if not key.startswith("amount_"):
            continue
        if not raw_value or not raw_value.strip():
            continue
        try:
            category_id = int(key[len("amount_"):])
        except ValueError:
            continue
        if category_id not in category_names_by_id:
            continue
        try:
            amount = parse_amount_vnd(raw_value)
            if amount <= 0:
                raise ValueError
        except ValueError:
            failed_category_names.append(category_names_by_id[category_id])
            continue
        set_period_budget(cursor, category_id=category_id, period_id=period_id, amount=amount, source="manual")

    conn.commit()
    conn.close()
    redirect_kwargs = {"period": period_id}
    if failed_category_names:
        redirect_kwargs["error"] = (
            "Không hiểu số tiền cho: " + ", ".join(failed_category_names) + " — chưa được lưu."
        )
    return redirect(url_for("budgets_page", **redirect_kwargs))


@app.route("/api/ai/budget-suggestion")
def api_ai_budget_suggestion():
    conn = connect_db()
    cursor = conn.cursor()

    start_day = period.get_period_start_day(cursor)
    period_id = request.args.get("period") or period.current_period_id(cursor)
    formula_suggestions = risk.suggest_period_budget_amounts(cursor, period_id)
    recent_ids = period.recent_period_ids_for(period_id, 3, start_day, include_current=False)

    cursor.execute("SELECT id, name_vi FROM categories WHERE kind = 'expense'")
    category_names = {row["id"]: row["name_vi"] for row in cursor.fetchall()}

    data = []
    for category_id, suggestion in formula_suggestions.items():
        history = [
            risk.get_actual_spend_in_period(cursor, category_id, pid, start_day)
            for pid in recent_ids
        ]
        data.append({
            "category_id": category_id,
            "category_name": category_names.get(category_id, ""),
            "formula_suggested_amount": suggestion["amount"],
            "recent_periods_actual_spend": history,
        })

    if not data:
        conn.close()
        return jsonify({"available": False, "reason": "no_data", "data": None})

    prompt_template = (PROMPTS_DIR / "budget_suggestion.md").read_text(encoding="utf-8")
    prompt = prompt_template.format(period_id=period_id, data_json=json.dumps(data, ensure_ascii=False))

    result = get_ai_suggestion(
        cursor,
        task="budget_suggestion",
        input_data={"period_id": period_id, "categories": data},
        response_schema=BudgetSuggestionResult,
        prompt=prompt,
    )
    conn.commit()
    conn.close()
    return jsonify(result)


def _goal_row_display(goal, progress):
    return {
        "id": goal["id"],
        "name": goal["name"],
        "type_label": GOAL_TYPE_LABELS.get(goal["goal_type"], goal["goal_type"]),
        "target_display": f"{goal['target_amount']:,} đ",
        "current_display": f"{goal['current_balance']:,} đ",
        "account_name": goal["account_name"],
        "deadline": goal["deadline"],
        "progress_pct": progress["progress_pct"],
        "remaining_display": f"{progress['remaining_amount']:,} đ",
        "periods_remaining": progress["periods_remaining"],
        "required_per_period_display": f"{progress['required_per_period']:,} đ",
        "is_off_track": progress["is_off_track"],
        "is_overdue": progress["is_overdue"],
    }


@app.route("/goals")
def goals_page():
    conn = connect_db()
    cursor = conn.cursor()
    goals = get_goals(cursor)
    rows = [_goal_row_display(g, risk.get_goal_progress(cursor, g)) for g in goals]
    conn.close()
    return render_template_string(GOALS_TEMPLATE, rows=rows, show_ai_panel=len(rows) >= 2)


@app.route("/goals/new", methods=["GET", "POST"])
def goals_new():
    conn = connect_db()
    cursor = conn.cursor()

    if request.method == "POST":
        name = (request.form.get("name") or "").strip()
        goal_type = request.form.get("goal_type") or "custom"
        deadline = request.form.get("deadline")
        target_amount_raw = request.form.get("target_amount") or ""
        event_plan_id_raw = request.form.get("event_plan_id") or ""

        # On any validation failure, redirect back to THIS same form with
        # what was typed preserved via query params + a clear reason why —
        # confirmed live that the old bare `except: redirect(url_for(...))`
        # (no params) silently wiped the whole form on e.g. "1tr" typed into
        # the amount field, with no error shown at all.
        def back_with_error(message):
            conn.close()
            return redirect(url_for(
                "goals_new", error=message, name=name,
                target_amount=target_amount_raw, deadline=deadline or "",
                event_plan_id=event_plan_id_raw,
            ))

        if not name:
            return back_with_error("Vui lòng nhập tên mục tiêu.")
        if not deadline:
            return back_with_error("Vui lòng chọn hạn chót.")
        try:
            target_amount = parse_amount_vnd(target_amount_raw)
            if target_amount <= 0:
                raise ValueError("Số tiền đích phải lớn hơn 0.")
        except ValueError as exc:
            return back_with_error(str(exc))
        try:
            account_id = int(request.form.get("account_id"))
        except (TypeError, ValueError):
            return back_with_error("Vui lòng chọn tài khoản.")

        new_goal_id = create_goal(cursor, name=name, goal_type=goal_type, target_amount=target_amount,
                                   deadline=deadline, account_id=account_id)
        # Completes the goal↔event_plan linkage the "Tạo mục tiêu" button on
        # /events/<id>'s goal-prompt promises — found broken (Mốc 2, predates
        # this hardening pass) while auditing: that link only ever pre-filled
        # this form via query params, it never actually passed event_plan_id
        # through or called link_event_plan_to_goal, so linked_goal_id never
        # got set and the same prompt would silently reappear on every later
        # visit to that event even after "accepting" it.
        if event_plan_id_raw:
            try:
                link_event_plan_to_goal(cursor, int(event_plan_id_raw), new_goal_id)
            except ValueError:
                pass
        conn.commit()
        conn.close()
        return redirect(url_for("goals_page"))

    accounts = accounts_as_json(cursor)
    emergency_fund_suggestion = risk.suggest_emergency_fund_target(cursor)
    conn.close()
    return render_template_string(
        GOALS_NEW_TEMPLATE,
        accounts=accounts,
        goal_types=[{"value": k, "label": v} for k, v in GOAL_TYPE_LABELS.items()],
        emergency_fund_suggestion=emergency_fund_suggestion or 0,
        emergency_fund_suggestion_display=f"{emergency_fund_suggestion:,} đ" if emergency_fund_suggestion else "",
        prefill_name=request.args.get("name", ""),
        prefill_target=request.args.get("target_amount", ""),
        prefill_deadline=request.args.get("deadline", ""),
        prefill_event_plan_id=request.args.get("event_plan_id", ""),
        error=request.args.get("error"),
        today=date.today().isoformat(),
    )


@app.route("/goals/<int:goal_id>")
def goal_detail(goal_id):
    conn = connect_db()
    cursor = conn.cursor()
    goal = get_goal_by_id(cursor, goal_id)
    if goal is None:
        conn.close()
        return "Không tìm thấy mục tiêu.", 404
    row = _goal_row_display(goal, risk.get_goal_progress(cursor, goal))
    conn.close()
    return render_template_string(GOAL_DETAIL_TEMPLATE, goal=row)


@app.route("/goals/<int:goal_id>/deactivate", methods=["POST"])
def deactivate_goal_route(goal_id):
    """transaction.deactivate_goal existed since Mốc 2 but had no CLI menu
    option or web route ever calling it — found while auditing: once
    created, a goal had NO way to ever be marked done/abandoned short of
    editing the SQLite file directly, since get_goals() only ever lists
    is_active = 1 rows. This is the first caller."""
    conn = connect_db()
    cursor = conn.cursor()
    deactivate_goal(cursor, goal_id)
    conn.commit()
    conn.close()
    return redirect(url_for("goals_page"))


@app.route("/api/ai/goal-priority")
def api_ai_goal_priority():
    conn = connect_db()
    cursor = conn.cursor()
    goals = get_goals(cursor)

    if len(goals) < 2:
        conn.close()
        return jsonify({"available": False, "reason": "no_data", "data": None})

    data = []
    for g in goals:
        progress = risk.get_goal_progress(cursor, g)
        data.append({
            "goal_id": g["id"],
            "name": g["name"],
            "goal_type": g["goal_type"],
            "target_amount": g["target_amount"],
            "remaining_amount": progress["remaining_amount"],
            "periods_remaining": progress["periods_remaining"],
            "required_per_period": progress["required_per_period"],
        })
    total_required_per_period = sum(d["required_per_period"] for d in data)

    prompt_template = (PROMPTS_DIR / "goal_priority.md").read_text(encoding="utf-8")
    prompt = prompt_template.format(
        data_json=json.dumps(data, ensure_ascii=False),
        total_required_per_period=f"{total_required_per_period:,}",
    )
    result = get_ai_suggestion(
        cursor, task="goal_priority", input_data={"goals": data},
        response_schema=GoalPriorityResult, prompt=prompt,
    )
    conn.commit()
    conn.close()
    return jsonify(result)


@app.route("/events")
def events_page():
    conn = connect_db()
    cursor = conn.cursor()
    plans = get_event_plans(cursor)
    rows = []
    for p in plans:
        items = get_event_plan_items(cursor, p["id"])
        total = sum(i["expected_amount"] for i in items)
        rows.append({
            "id": p["id"],
            "name": p["name"],
            "event_date": p["event_date"] or "—",
            "total_display": f"{total:,} đ",
            "item_count": len(items),
            "linked_goal_id": p["linked_goal_id"],
        })
    conn.close()
    return render_template_string(EVENTS_TEMPLATE, rows=rows)


@app.route("/events/new", methods=["GET", "POST"])
def events_new():
    conn = connect_db()
    cursor = conn.cursor()

    if request.method == "POST":
        name = (request.form.get("name") or "").strip()
        event_date_value = request.form.get("event_date") or None
        template_id_raw = request.form.get("template_id")

        if not name:
            conn.close()
            return redirect(url_for(
                "events_new", error="Vui lòng nhập tên kế hoạch.",
                template=template_id_raw or "",
            ))
        try:
            template_id = int(template_id_raw) if template_id_raw else None
        except ValueError:
            template_id = None

        plan_id = create_event_plan(cursor, name=name, template_id=template_id, event_date=event_date_value)

        # Item rows are tolerant by design (a blank amount just means "no
        # estimate yet for this item", per THIET-KE.md's own "chỉ gợi ý
        # khoản mục, giá tự nhập" flow) — but a NON-blank amount that fails
        # to parse (e.g. "1tr" typed instead of "1000000") is a real mistake,
        # not an intentional blank, so it's collected and reported back
        # instead of just vanishing with no explanation.
        failed_item_names = []
        for key, raw_value in request.form.items():
            if not key.startswith("item_name_"):
                continue
            index = key[len("item_name_"):]
            item_name = (raw_value or "").strip()
            amount_raw = request.form.get(f"item_amount_{index}")
            if not item_name or not amount_raw or not amount_raw.strip():
                continue
            try:
                amount = parse_amount_vnd(amount_raw)
            except ValueError:
                failed_item_names.append(item_name)
                continue
            if amount > 0:
                add_event_plan_item(cursor, event_plan_id=plan_id, name=item_name, expected_amount=amount)

        conn.commit()

        # Goal-prompt trigger: total expected >= 10,000,000đ AND event is >= 2
        # periods away — fires once, at creation time only (see CLAUDE.md).
        items = get_event_plan_items(cursor, plan_id)
        total_expected = sum(i["expected_amount"] for i in items)
        suggest_goal = False
        if event_date_value and total_expected >= 10_000_000:
            start_day = period.get_period_start_day(cursor)
            current_id = period.current_period_id(cursor)
            event_period_id = period.period_id_for(date.fromisoformat(event_date_value), start_day)
            if period.periods_between(current_id, event_period_id) >= 2:
                suggest_goal = True

        conn.close()
        redirect_kwargs = {"event_plan_id": plan_id}
        if suggest_goal:
            redirect_kwargs["suggest_goal"] = 1
        if failed_item_names:
            redirect_kwargs["item_error"] = (
                "Không hiểu số tiền cho: " + ", ".join(failed_item_names) + " — các khoản này chưa được lưu."
            )
        return redirect(url_for("event_detail", **redirect_kwargs))

    templates = get_event_templates(cursor)
    template_id_raw = request.args.get("template")
    template_items = get_event_template_items(cursor, int(template_id_raw)) if template_id_raw else []
    conn.close()
    return render_template_string(
        EVENTS_NEW_TEMPLATE,
        templates=templates,
        selected_template_id=template_id_raw,
        template_items=template_items,
        prefill_name=request.args.get("name", ""),
        error=request.args.get("error"),
    )


@app.route("/events/<int:event_plan_id>")
def event_detail(event_plan_id):
    conn = connect_db()
    cursor = conn.cursor()
    plan = get_event_plan_by_id(cursor, event_plan_id)
    if plan is None:
        conn.close()
        return "Không tìm thấy kế hoạch.", 404
    items = get_event_plan_items(cursor, event_plan_id)
    total = sum(i["expected_amount"] for i in items)
    conn.close()

    show_goal_prompt = (
        request.args.get("suggest_goal") == "1"
        and not plan["linked_goal_id"]
        and not plan["goal_prompt_dismissed"]
    )

    return render_template_string(
        EVENT_DETAIL_TEMPLATE,
        plan={
            "id": plan["id"],
            "name": plan["name"],
            "event_date": plan["event_date"] or "",
        },
        items=[{"name": i["name"], "expected_display": f"{i['expected_amount']:,} đ"} for i in items],
        total_display=f"{total:,} đ",
        total_amount=total,
        show_goal_prompt=show_goal_prompt,
        error=request.args.get("item_error"),
    )


@app.route("/events/<int:event_plan_id>/dismiss-goal-prompt", methods=["POST"])
def event_dismiss_goal_prompt(event_plan_id):
    conn = connect_db()
    cursor = conn.cursor()
    dismiss_event_plan_goal_prompt(cursor, event_plan_id)
    conn.commit()
    conn.close()
    return redirect(url_for("event_detail", event_plan_id=event_plan_id))


@app.route("/simulate", methods=["GET", "POST"])
def simulate_page():
    conn = connect_db()
    cursor = conn.cursor()

    if request.method == "POST":
        name = (request.form.get("name") or "").strip()
        note = (request.form.get("note") or "").strip() or None
        item_amount_raw = request.form.get("item_amount") or ""
        maintenance_raw = request.form.get("maintenance_cost_per_period") or ""
        triggered_by_raw = request.form.get("triggered_by_transaction_id")

        def back_with_error(message):
            conn.close()
            return redirect(url_for(
                "simulate_page", error=message, name=name, amount=item_amount_raw,
                maintenance=maintenance_raw,
                lifetime=request.form.get("expected_lifetime_periods") or "",
                triggered_by_transaction_id=triggered_by_raw or "",
            ))

        if not name:
            return back_with_error("Vui lòng đặt tên cho mô phỏng này.")
        try:
            item_amount = parse_amount_vnd(item_amount_raw)
            if item_amount <= 0:
                raise ValueError("Số tiền phải lớn hơn 0.")
            maintenance_cost_per_period = parse_amount_vnd(maintenance_raw) if maintenance_raw.strip() else 0
            expected_lifetime_periods = int(request.form.get("expected_lifetime_periods") or "0")
        except ValueError as exc:
            return back_with_error(str(exc))

        triggered_by_transaction_id = int(triggered_by_raw) if triggered_by_raw else None

        liquidity_snapshot = risk.get_liquid_balance(cursor)
        scenarios, baseline_balances = risk.compute_spending_scenarios(
            cursor, item_amount=item_amount,
            maintenance_cost_per_period=maintenance_cost_per_period,
            expected_lifetime_periods=expected_lifetime_periods,
        )

        simulation_id = create_spending_simulation(
            cursor, name=name, note=note, item_amount=item_amount,
            maintenance_cost_per_period=maintenance_cost_per_period,
            expected_lifetime_periods=expected_lifetime_periods,
            liquidity_snapshot=liquidity_snapshot, baseline_balances=baseline_balances,
            triggered_by_transaction_id=triggered_by_transaction_id,
        )
        for s in scenarios:
            add_simulation_scenario(
                cursor, simulation_id=simulation_id, scenario_type=s["scenario_type"],
                installment_periods=s["installment_periods"], delay_periods=s["delay_periods"],
                total_cost_of_ownership=s["total_cost_of_ownership"],
                projected_balances=s["projected_balances"], traffic_light=s["traffic_light"],
            )
        conn.commit()
        conn.close()
        return redirect(url_for("simulation_detail", simulation_id=simulation_id))

    prefill_amount = request.args.get("amount", "")
    prefill_name = request.args.get("name", "")
    prefill_maintenance = request.args.get("maintenance", "")
    prefill_lifetime = request.args.get("lifetime", "")
    triggered_by = request.args.get("triggered_by_transaction_id", "")
    conn.close()
    return render_template_string(
        SIMULATE_TEMPLATE,
        prefill_amount=prefill_amount,
        prefill_name=prefill_name,
        prefill_maintenance=prefill_maintenance,
        prefill_lifetime=prefill_lifetime,
        triggered_by=triggered_by,
        error=request.args.get("error"),
    )


@app.route("/simulations")
def simulations_page():
    conn = connect_db()
    cursor = conn.cursor()
    sims = get_spending_simulations(cursor)
    conn.close()
    rows = [
        {
            "id": s["id"],
            "name": s["name"],
            "note": s["note"] or "",
            "item_amount_display": f"{s['item_amount']:,} đ",
            "created_at": s["created_at"],
        }
        for s in sims
    ]
    return render_template_string(SIMULATIONS_TEMPLATE, rows=rows)


@app.route("/simulations/<int:simulation_id>")
def simulation_detail(simulation_id):
    conn = connect_db()
    cursor = conn.cursor()
    simulation = get_spending_simulation_by_id(cursor, simulation_id)
    if simulation is None:
        conn.close()
        return "Không tìm thấy mô phỏng.", 404
    scenario_rows = get_simulation_scenarios(cursor, simulation_id)
    conn.close()

    scenarios = []
    pay_now_balances = None
    for s in scenario_rows:
        balances = json.loads(s["projected_balances"])
        scenarios.append({
            "label": scenario_label(s),
            "tco_display": f"{s['total_cost_of_ownership']:,} đ",
            "traffic_light": s["traffic_light"],
            "traffic_label": TRAFFIC_LIGHT_LABELS.get(s["traffic_light"], s["traffic_light"]),
            "traffic_color": TRAFFIC_LIGHT_COLORS.get(s["traffic_light"], ""),
            "balances": balances,
        })
        if s["scenario_type"] == "pay_now":
            pay_now_balances = balances

    baseline_balances = json.loads(simulation["baseline_balances"]) if simulation["baseline_balances"] else []
    ai_recommendation = json.loads(simulation["ai_recommendation"]) if simulation["ai_recommendation"] else None

    return render_template_string(
        SIMULATION_DETAIL_TEMPLATE,
        simulation_id=simulation_id,
        name=simulation["name"],
        note=simulation["note"] or "",
        item_amount_display=f"{simulation['item_amount']:,} đ",
        ai_recommendation=ai_recommendation,
        scenarios=scenarios,
        chart_labels=list(range(1, len(baseline_balances) + 1)),
        chart_baseline=baseline_balances,
        chart_with_expense=pay_now_balances or [],
    )


@app.route("/api/ai/simulation-advice")
def api_ai_simulation_advice():
    simulation_id = request.args.get("simulation_id", type=int)
    conn = connect_db()
    cursor = conn.cursor()
    simulation = get_spending_simulation_by_id(cursor, simulation_id)
    if simulation is None:
        conn.close()
        return jsonify({"available": False, "reason": "no_data", "data": None})

    # The recommendation is frozen the first time it's successfully generated
    # (see create_spending_simulation's docstring) — never re-queried after
    # that, so looking back at an old simulation always shows what was
    # actually advised at the time, not a fresh (possibly different) answer.
    if simulation["ai_recommendation"]:
        conn.close()
        return jsonify({"available": True, "data": json.loads(simulation["ai_recommendation"]), "cached": True})

    scenario_rows = get_simulation_scenarios(cursor, simulation_id)
    scenario_data = [
        {
            "scenario_label": scenario_label(s),
            "total_cost_of_ownership": s["total_cost_of_ownership"],
            "traffic_light": s["traffic_light"],
            "projected_balances": json.loads(s["projected_balances"]),
        }
        for s in scenario_rows
    ]

    maintenance_text = (
        f", chi phí duy trì {simulation['maintenance_cost_per_period']:,} đ/kỳ trong "
        f"{simulation['expected_lifetime_periods']} kỳ"
        if simulation["maintenance_cost_per_period"] else ""
    )
    prompt_template = (PROMPTS_DIR / "simulation_advice.md").read_text(encoding="utf-8")
    prompt = prompt_template.format(
        item_name=simulation["name"],
        item_amount=f"{simulation['item_amount']:,}",
        maintenance_text=maintenance_text,
        scenarios_json=json.dumps(scenario_data, ensure_ascii=False),
    )

    result = get_ai_suggestion(
        cursor, task="simulation_advice", input_data={"simulation_id": simulation_id},
        response_schema=SpendingSimulationAdvice, prompt=prompt, model=DEFAULT_MODEL_HEAVY,
    )
    if result["available"]:
        set_simulation_ai_recommendation(cursor, simulation_id, result["data"])
    conn.commit()
    conn.close()
    return jsonify(result)


FORECAST_PERIODS_AHEAD_OPTIONS = (6, 9, 12)
FORECAST_MAX_IRREGULAR_INCOME_FIELDS = 12


def _total_goal_contribution_per_period(cursor):
    """Sum of every ACTIVE goal's required_per_period (risk.get_goal_progress),
    skipping goals that are already overdue or have 0 periods remaining —
    those don't have an ongoing "set aside this much per period" ask."""
    total = 0
    for g in get_goals(cursor):
        progress = risk.get_goal_progress(cursor, g)
        if not progress["is_overdue"] and progress["periods_remaining"] > 0:
            total += progress["required_per_period"]
    return total


def _nearest_upcoming_event(cursor):
    """The soonest event_plan whose event_date hasn't passed yet, or None —
    shared by dashboard() (a card the user sees) and api_ai_daily_summary()
    (so the AI's synthesis references the same upcoming event, not two
    independently-computed answers to "what's coming up")."""
    today_date = date.today()
    upcoming = [
        p for p in get_event_plans(cursor)
        if p["event_date"] and date.fromisoformat(p["event_date"]) >= today_date
    ]
    if not upcoming:
        return None
    upcoming.sort(key=lambda p: p["event_date"])
    p = upcoming[0]
    items = get_event_plan_items(cursor, p["id"])
    return {
        "id": p["id"],
        "name": p["name"],
        "days_remaining": (date.fromisoformat(p["event_date"]) - today_date).days,
        "total_expected": sum(i["expected_amount"] for i in items),
    }


def _goals_status_summary(cursor):
    """{"total", "on_track_count", "off_track": [{"name", "remaining_amount",
    "reason"}]} — shared by dashboard() and api_ai_daily_summary() for the
    same reason as _nearest_upcoming_event above."""
    goals = get_goals(cursor)
    on_track_count = 0
    off_track = []
    for g in goals:
        progress = risk.get_goal_progress(cursor, g)
        if progress["is_overdue"] or progress["is_off_track"]:
            off_track.append({
                "name": g["name"],
                "remaining_amount": progress["remaining_amount"],
                "reason": "overdue" if progress["is_overdue"] else "off_track",
            })
        else:
            on_track_count += 1
    return {"total": len(goals), "on_track_count": on_track_count, "off_track": off_track}


def _seasonality_patterns_display(patterns):
    return [
        {
            "month_label": f"Tháng {p['month']}",
            "avg_expense_display": f"{p['avg_expense']:,} đ",
            "overall_avg_display": f"{p['overall_avg']:,} đ",
            "pct_difference": p["pct_difference"],
            "stdev_display": f"{p['stdev']:,} đ",
            "sample_count": p["sample_count"],
        }
        for p in patterns
    ]


@app.route("/forecast", methods=["GET", "POST"])
def forecast_page():
    conn = connect_db()
    cursor = conn.cursor()

    if request.method == "POST":
        try:
            periods_ahead = int(request.form.get("periods_ahead", 6))
        except ValueError:
            periods_ahead = 6
        if periods_ahead not in FORECAST_PERIODS_AHEAD_OPTIONS:
            periods_ahead = 6

        irregular_income_by_offset = {}
        for i in range(periods_ahead):
            raw = request.form.get(f"irregular_income_{i}") or ""
            if raw.strip():
                try:
                    irregular_income_by_offset[i] = parse_amount_vnd(raw)
                except ValueError:
                    pass

        apply_seasonality = request.form.get("apply_seasonality") == "on"
        seasonality = risk.detect_seasonality(cursor)
        patterns = seasonality["patterns"] if apply_seasonality else []

        goal_contribution = _total_goal_contribution_per_period(cursor)
        results = risk.compute_cashflow_forecast(
            cursor, periods_ahead,
            goal_contribution_per_period=goal_contribution,
            irregular_income_by_offset=irregular_income_by_offset,
            seasonality_patterns=patterns,
        )

        forecast_id = create_cashflow_forecast(
            cursor, periods_ahead=periods_ahead, scenario="base",
            seasonality_applied=apply_seasonality,
            seasonality_details=patterns if apply_seasonality else None,
        )
        for r in results:
            add_forecast_period(
                cursor, forecast_id=forecast_id, period_index=r["period_index"],
                period_id=r["period_id"], projected_balance=r["projected_balance"],
                projected_income=r["projected_income"], projected_expense=r["projected_expense"],
                is_danger=r["is_danger"],
            )
        conn.commit()
        conn.close()
        return redirect(url_for("forecast_detail", forecast_id=forecast_id))

    forecasts = get_cashflow_forecasts(cursor)
    latest_base = next((f for f in forecasts if f["scenario"] == "base"), None)
    if latest_base is not None:
        conn.close()
        return redirect(url_for("forecast_detail", forecast_id=latest_base["id"]))

    seasonality = risk.detect_seasonality(cursor)
    conn.close()
    return render_template_string(
        FORECAST_TEMPLATE,
        has_forecast=False,
        periods_ahead_options=FORECAST_PERIODS_AHEAD_OPTIONS,
        irregular_income_field_range=range(FORECAST_MAX_IRREGULAR_INCOME_FIELDS),
        seasonality_has_data=seasonality["has_enough_data"],
        seasonality_patterns=_seasonality_patterns_display(seasonality["patterns"]),
        enable_macro_context=ENABLE_MACRO_CONTEXT,
    )


@app.route("/forecast/<int:forecast_id>")
def forecast_detail(forecast_id):
    conn = connect_db()
    cursor = conn.cursor()
    forecast = get_cashflow_forecast_by_id(cursor, forecast_id)
    if forecast is None:
        conn.close()
        return "Không tìm thấy dự báo.", 404
    periods = get_forecast_periods(cursor, forecast_id)
    seasonality = risk.detect_seasonality(cursor)
    conn.close()

    rows = [
        {
            "period_id": p["period_id"],
            "balance_display": f"{p['projected_balance']:,} đ",
            "income_display": f"{p['projected_income']:,} đ",
            "expense_display": f"{p['projected_expense']:,} đ",
            "is_danger": bool(p["is_danger"]),
        }
        for p in periods
    ]

    return render_template_string(
        FORECAST_TEMPLATE,
        has_forecast=True,
        forecast_id=forecast_id,
        scenario=forecast["scenario"],
        seasonality_applied=bool(forecast["seasonality_applied"]),
        base_forecast_id=forecast["base_forecast_id"],
        rows=rows,
        chart_labels=[p["period_id"] for p in periods],
        chart_balances=[p["projected_balance"] for p in periods],
        any_danger=any(p["is_danger"] for p in periods),
        periods_ahead_options=FORECAST_PERIODS_AHEAD_OPTIONS,
        irregular_income_field_range=range(FORECAST_MAX_IRREGULAR_INCOME_FIELDS),
        seasonality_has_data=seasonality["has_enough_data"],
        seasonality_patterns=_seasonality_patterns_display(seasonality["patterns"]),
        enable_macro_context=ENABLE_MACRO_CONTEXT,
    )


@app.route("/forecast/<int:forecast_id>/macro-scenario", methods=["POST"])
def forecast_macro_scenario(forecast_id):
    conn = connect_db()
    cursor = conn.cursor()
    base = get_cashflow_forecast_by_id(cursor, forecast_id)
    if base is None:
        conn.close()
        return "Không tìm thấy dự báo.", 404

    raw = request.form.get("macro_adjustment") or ""
    try:
        macro_adjustment = parse_amount_vnd(raw) if raw.strip() else 0
    except ValueError:
        macro_adjustment = 0

    macro_context_note = request.form.get("macro_context_note") or None
    try:
        macro_context_sources = json.loads(request.form.get("macro_context_sources") or "[]")
    except ValueError:
        macro_context_sources = []

    base_periods = get_forecast_periods(cursor, forecast_id)
    new_forecast_id = create_cashflow_forecast(
        cursor, periods_ahead=base["periods_ahead"], scenario="macro_adjusted",
        base_forecast_id=forecast_id, macro_adjustment=macro_adjustment,
        macro_context_note=macro_context_note, macro_context_sources=macro_context_sources,
    )

    essential = risk.get_average_period_essential_expense(cursor)
    balance = risk.get_liquid_balance(cursor)
    for p in base_periods:
        new_expense = p["projected_expense"] + macro_adjustment
        balance = balance + p["projected_income"] - new_expense
        is_danger = balance < 0 or (essential is not None and balance < essential)
        add_forecast_period(
            cursor, forecast_id=new_forecast_id, period_index=p["period_index"],
            period_id=p["period_id"], projected_balance=round(balance),
            projected_income=p["projected_income"], projected_expense=round(new_expense),
            is_danger=is_danger,
        )
    conn.commit()
    conn.close()
    return redirect(url_for("forecast_detail", forecast_id=new_forecast_id))


@app.route("/api/ai/macro-context")
def api_ai_macro_context():
    if not ENABLE_MACRO_CONTEXT:
        return jsonify({"available": False, "reason": "disabled", "data": None})
    conn = connect_db()
    cursor = conn.cursor()
    prompt = (PROMPTS_DIR / "macro_context.md").read_text(encoding="utf-8")
    result = get_macro_context(cursor, prompt)
    conn.commit()
    conn.close()
    return jsonify(result)


RUNWAY_LEVEL_LABELS = {
    "nguy_hiem": "Nguy hiểm",
    "mong_manh": "Mong manh",
    "on": "Ổn",
    "vung": "Vững",
}

HEALTH_LEVEL_COLORS = {
    "nguy_hiem": "bg-rose-500",
    "mong_manh": "bg-amber-500",
    "on": "bg-sky-500",
    "vung": "bg-emerald-500",
}

SAVINGS_TREND_LABELS = {
    "improving": "↑ Đang cải thiện",
    "declining": "↓ Đang giảm",
    "stable": "→ Ổn định",
}


@app.route("/risk")
def risk_page():
    conn = connect_db()
    cursor = conn.cursor()

    forecast = risk.short_term_forecast(cursor)
    liquidity = risk.liquidity_risk(cursor)
    runway = risk.runway_months(cursor)
    margin = risk.income_sustainability_margin(cursor)
    this_period = period.current_period_id(cursor)
    this_month = datetime.now().strftime("%Y-%m")  # get_budget_status stays calendar-month, see risk.py
    budget = risk.budget_balance_50_30_20(cursor, this_period)
    budget_statuses = risk.get_budget_status(cursor, this_month)
    savings_trend = risk.get_savings_rate_trend(cursor)

    conn.close()

    return render_template_string(
        RISK_TEMPLATE,
        period_id=this_period,
        month=this_month,
        forecast={
            "liquid_balance_display": f"{forecast['liquid_balance']:,} đ",
            "remaining_recurring_display": f"{forecast['remaining_recurring']:,} đ",
            "projected_spend_display": f"{forecast['projected_variable_spend']:,} đ",
            "forecast_balance_display": f"{forecast['forecast_balance']:,} đ",
            "at_risk": forecast["at_risk"],
        },
        liquidity={
            "has_data": liquidity["essential_monthly_expense"] is not None,
            "liquid_balance_display": f"{liquidity['liquid_balance']:,} đ",
            "essential_monthly_display": (
                f"{liquidity['essential_monthly_expense']:,.0f} đ"
                if liquidity["essential_monthly_expense"] else ""
            ),
            "sufficient": liquidity["sufficient"],
        },
        runway={
            "has_data": runway["months"] is not None,
            "months_display": f"{runway['months']:.1f}" if runway["months"] is not None else "",
            "level": runway["level"],
            "level_label": RUNWAY_LEVEL_LABELS.get(runway["level"], ""),
        },
        margin={
            "has_data": margin["has_data"],
            "reliable_income_display": f"{margin['reliable_income']:,.0f} đ" if margin["has_data"] else "",
            "essential_monthly_display": f"{margin['essential_monthly_expense']:,.0f} đ" if margin["has_data"] else "",
            "margin_display": f"{margin['margin']:,.0f} đ" if margin["has_data"] else "",
            "sufficient": margin["sufficient"],
        },
        budget={
            "has_income": budget["income"] > 0,
            "essential_display": f"{budget['essential']:,} đ",
            "optional_display": f"{budget['optional']:,} đ",
            "savings_display": f"{budget['savings']:,} đ",
            "essential_pct": f"{budget['essential_pct']:.0f}" if budget["essential_pct"] is not None else "",
            "optional_pct": f"{budget['optional_pct']:.0f}" if budget["optional_pct"] is not None else "",
            "savings_pct": f"{budget['savings_pct']:.0f}" if budget["savings_pct"] is not None else "",
        },
        budget_statuses=[
            {
                "category_name": s["category_name"],
                "spent_display": f"{s['spent']:,} đ",
                "limit_display": f"{s['monthly_limit']:,} đ",
                "pct_used": min(s["pct_used"], 100),
                "pct_display": f"{s['pct_used']:.0f}",
                "over_budget": s["over_budget"],
            }
            for s in budget_statuses
        ],
        savings_trend={
            "has_data": bool(savings_trend["periods"]),
            "periods": [
                {
                    "period_id": p["period_id"],
                    "savings_display": f"{p['savings']:,} đ",
                    "rate_display": f"{p['savings_rate']:.0f}%" if p["savings_rate"] is not None else "—",
                    "positive": p["savings"] >= 0,
                }
                for p in savings_trend["periods"]
            ],
            "trend_label": SAVINGS_TREND_LABELS.get(savings_trend["trend"]),
        },
    )


@app.route("/import", methods=["GET", "POST"])
def import_page():
    if request.method != "POST":
        return render_template_string(IMPORT_TEMPLATE, error=None)

    images = [f for f in request.files.getlist("images") if f.filename]
    if not images:
        return render_template_string(IMPORT_TEMPLATE, error="Chưa chọn ảnh nào.")

    conn = connect_db()
    cursor = conn.cursor()

    categories_by_kind = {
        "expense": category_tree_as_json(cursor, "expense"),
        "income": category_tree_as_json(cursor, "income"),
    }

    debug_blocks = []
    candidates = []
    try:
        for image_index, image in enumerate(images):
            image_bytes = image.stream.read()
            found = analyze_image(image_bytes, image.mimetype or "image/png", categories_by_kind, cursor=cursor)
            debug_blocks.append(
                f"--- Ảnh #{image_index + 1} ({image.filename}) ---\n"
                + ("\n".join(f"{c['amount']:,} đ ({c['direction']}) — {c['note']!r}" for c in found) or "(không tìm thấy giao dịch nào)")
            )
            for candidate in found:
                candidate["image_index"] = image_index
                candidate["kind"] = "expense" if candidate["direction"] == "out" else "income"
                # AI's own semantic guess wins; only fall back to the keyword-based
                # rules engine when Gemini wasn't confident enough to suggest one.
                candidate["suggested_category_id"] = candidate["category_id"] or apply_matching_rule(cursor, candidate["note"])
                candidates.append(candidate)
    except Exception as exc:
        conn.commit()  # keep the ai_calls failure entry analyze_image() just logged
        conn.close()
        return render_template_string(
            IMPORT_TEMPLATE,
            error=f"Không đọc được ảnh (kiểm tra GEMINI_API_KEY, hoặc thử lại): {exc}",
        )

    accounts = accounts_as_json(cursor)
    all_categories = category_tree_as_json(cursor, "expense") + category_tree_as_json(cursor, "income")
    conn.commit()  # keep the ai_calls success entries analyze_image() logged per image
    conn.close()

    if not candidates:
        return render_template_string(
            IMPORT_TEMPLATE,
            error="Không tìm thấy giao dịch nào trong ảnh. Xem kết quả bên dưới để biết vì sao.",
            raw_text="\n\n".join(debug_blocks),
        )

    return render_template_string(
        IMPORT_REVIEW_TEMPLATE,
        candidates=candidates,
        raw_text="\n\n".join(debug_blocks),
        accounts=accounts,
        categories=all_categories,
        today=datetime.now().strftime("%Y-%m-%d"),
    )


@app.route("/import/confirm", methods=["POST"])
def import_confirm():
    conn = connect_db()
    cursor = conn.cursor()

    saved = 0
    skipped_duplicate = 0
    skipped_invalid = 0

    for i in request.form.getlist("include"):
        try:
            amount = parse_amount_vnd(request.form.get(f"amount_{i}", ""))
            account_id = int(request.form.get(f"account_{i}"))
        except (TypeError, ValueError):
            skipped_invalid += 1
            continue

        direction = request.form.get(f"direction_{i}")
        if amount <= 0 or direction not in ("in", "out"):
            skipped_invalid += 1
            continue

        category_id_raw = request.form.get(f"category_{i}")
        category_id = int(category_id_raw) if category_id_raw else None
        suggested_raw = request.form.get(f"suggested_{i}")
        suggested_category_id = int(suggested_raw) if suggested_raw else None
        note = (request.form.get(f"note_{i}") or "").strip()
        date_raw = request.form.get(f"date_{i}")
        occurred_at = f"{date_raw} 00:00:00" if date_raw else datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        external_ref = make_external_ref(amount, direction, note)

        try:
            insert_transaction(
                cursor, occurred_at=occurred_at, amount=amount, direction=direction,
                account_id=account_id, category_id=category_id, description=note,
                source="ocr", is_reviewed=0, external_ref=external_ref,
            )
            new_transaction_id = cursor.lastrowid
            # User corrected the AI's category guess for this note — learn a rule
            # from it, same mechanism as correcting a transaction's category
            # manually (transaction.py's add_rule with created_from="learned").
            # This is what lets categorization improve as more screenshots come
            # in, instead of every note being judged fresh by the AI each time.
            if category_id is not None and category_id != suggested_category_id and note:
                add_rule(cursor, pattern=note, category_id=category_id, created_from="learned")
            # Only log accept/reject when Gemini actually suggested something —
            # no suggestion means there's nothing the user is accepting/rejecting.
            if suggested_category_id is not None:
                event_type = (
                    "ai_suggestion_accepted" if category_id == suggested_category_id
                    else "ai_suggestion_rejected"
                )
                log_behavior_event(
                    cursor, event_type, transaction_id=new_transaction_id,
                    payload={"suggested_category_id": suggested_category_id, "final_category_id": category_id},
                )
            conn.commit()
            saved += 1
        except sqlite3.IntegrityError:
            conn.rollback()
            skipped_duplicate += 1

    conn.close()
    # Previously a bare redirect with zero summary of what actually
    # happened — `saved`/`skipped_duplicate` were tracked but never shown
    # anywhere, so uploading e.g. 5 screenshots gave no confirmation of how
    # many were really saved vs. silently skipped as duplicates/invalid.
    return redirect(url_for(
        "transactions_page", import_saved=saved,
        import_skipped_duplicate=skipped_duplicate, import_skipped_invalid=skipped_invalid,
    ))


@app.route("/api/transactions", methods=["POST"])
def create_transaction():
    data = request.get_json(silent=True) or {}

    direction = data.get("direction")
    if direction not in ("in", "out"):
        return jsonify(ok=False, message="Loại giao dịch không hợp lệ."), 400

    try:
        account_id = int(data.get("account_id"))
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Vui lòng chọn tài khoản."), 400

    category_id_raw = data.get("category_id")
    category_id = int(category_id_raw) if category_id_raw not in (None, "") else None

    raw_amount = data.get("amount")
    try:
        # amount arrives as free text from the JS amount field, which allows
        # Vietnamese shorthand ("1tr", "500k", "2tr5") through untouched
        # rather than stripping it to digits-only — see PAGE_TEMPLATE's own
        # comment on why the old digit-strip-as-you-type approach silently
        # turned "1tr" into "1" (1 đồng) with no warning at all.
        amount = int(raw_amount) if isinstance(raw_amount, (int, float)) else parse_amount_vnd(str(raw_amount))
        if amount <= 0:
            raise ValueError("Số tiền phải lớn hơn 0.")
    except (TypeError, ValueError) as exc:
        return jsonify(ok=False, message=str(exc) or "Số tiền không hợp lệ."), 400

    description = (data.get("description") or "").strip()

    conn = connect_db()
    cursor = conn.cursor()

    cursor.execute("SELECT 1 FROM accounts WHERE id = ? AND is_active = 1", (account_id,))
    if cursor.fetchone() is None:
        conn.close()
        return jsonify(ok=False, message="Tài khoản không hợp lệ."), 400

    if category_id is not None:
        cursor.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify(ok=False, message="Danh mục không hợp lệ."), 400

    resolved_category_id = resolve_category(cursor, category_id, description)
    auto_categorized = resolved_category_id is not None and category_id is None

    occurred_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    insert_transaction(
        cursor,
        occurred_at=occurred_at,
        amount=amount,
        direction=direction,
        account_id=account_id,
        category_id=resolved_category_id,
        description=description,
    )

    conn.commit()
    conn.close()

    message = f"Đã ghi nhận giao dịch: {amount:,} đ"
    if auto_categorized:
        message += " (tự động phân loại)"
    return jsonify(ok=True, message=message)


@app.route("/api/transactions/transfer", methods=["POST"])
def create_transfer():
    """Moving money between the user's OWN accounts (topping up MoMo from a
    bank transfer, an ATM cash withdrawal, paying off a credit card, ...) —
    categories.kind='transfer' has existed since Stage 1's schema but had no
    CLI/web screen ever using it until now, meaning there was no way to
    correctly record this extremely common personal-finance action without
    it silently inflating income or expense totals (a plain 'out' from one
    account, or worse, one leg entered and the other forgotten). See
    transaction.insert_transfer and risk.NOT_TRANSFER_CLAUSE."""
    data = request.get_json(silent=True) or {}

    try:
        from_account_id = int(data.get("from_account_id"))
        to_account_id = int(data.get("to_account_id"))
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Vui lòng chọn tài khoản nguồn và đích."), 400

    raw_amount = data.get("amount")
    try:
        amount = int(raw_amount) if isinstance(raw_amount, (int, float)) else parse_amount_vnd(str(raw_amount))
        if amount <= 0:
            raise ValueError("Số tiền phải lớn hơn 0.")
    except (TypeError, ValueError) as exc:
        return jsonify(ok=False, message=str(exc) or "Số tiền không hợp lệ."), 400

    description = (data.get("description") or "").strip()

    conn = connect_db()
    cursor = conn.cursor()

    cursor.execute(
        "SELECT COUNT(*) AS n FROM accounts WHERE id IN (?, ?) AND is_active = 1",
        (from_account_id, to_account_id),
    )
    if cursor.fetchone()["n"] != 2:
        conn.close()
        return jsonify(ok=False, message="Tài khoản không hợp lệ."), 400

    try:
        insert_transfer(
            cursor, from_account_id=from_account_id, to_account_id=to_account_id,
            amount=amount, description=description,
        )
    except ValueError as exc:
        conn.close()
        return jsonify(ok=False, message=str(exc)), 400

    conn.commit()
    conn.close()
    return jsonify(ok=True, message=f"Đã chuyển khoản: {amount:,} đ")


LOGIN_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Đăng nhập — Sổ tài chính</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    min-height: 100vh;
    display: flex;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f5f7;
    color: #1c1c1e;
  }
  .card {
    max-width: 360px;
    margin: 0 auto;
    background: #fff;
    border-radius: 14px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    width: 100%;
  }
  h1 { font-size: 1.15rem; margin: 0 0 18px; text-align: center; }
  input[type="password"] {
    width: 100%;
    padding: 14px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
  }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
  .error {
    margin-top: 12px;
    padding: 10px;
    border-radius: 10px;
    text-align: center;
    background: #fdecea;
    color: #c0392b;
    font-size: 0.9rem;
  }
</style>
</head>
<body>
<div class="card">
  <h1>Nhập mã truy cập</h1>
  <form method="post">
    <input type="password" name="password" placeholder="Mã truy cập" autocomplete="current-password" autofocus required>
    <button type="submit">Vào</button>
  </form>
  {% if error %}<div class="error">{{ error }}</div>{% endif %}
</div>
</body>
</html>
"""


# Shared by PAGE_TEMPLATE / LIST_TEMPLATE / SUMMARY_TEMPLATE — kept as a plain
# (non-f, non-Jinja) string so the CSS's { } don't need escaping.
BASE_STYLE = """
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f5f7;
    color: #1c1c1e;
  }
  .nav {
    max-width: 480px;
    margin: 0 auto 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .nav a {
    flex: 1 1 30%;
    text-align: center;
    padding: 9px 2px;
    border-radius: 10px;
    background: #fff;
    color: #1c1c1e;
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .nav a.active { background: #007aff; color: #fff; }
  .card {
    max-width: 480px;
    margin: 0 auto;
    background: #fff;
    border-radius: 14px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 16px;
    text-align: center;
  }
"""


# Shared by the Tailwind-based pages (Danh sách, Tổng quan, Luật phân loại) —
# head boilerplate + Play CDN + a tiny theme extension for the shared "brand"
# blue (kept identical to BASE_STYLE's #007aff so both design systems still
# feel like one app). Kept as a plain string for the same reason as
# BASE_STYLE: no Jinja/f-string brace escaping to worry about.
TAILWIND_HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: { brand: "#007aff" },
        fontFamily: {
          sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        },
      },
    },
  };
</script>
"""


# Segmented pill nav shared by the Tailwind pages. {active} is one of
# "dashboard", "add", "list", "summary", "budgets", "goals", "rules". Built as
# a plain function (not Jinja) since it never needs request-time data, just
# which page is currently active.
def tailwind_nav(active):
    def link(href, label, key):
        classes = "flex-1 text-center py-2.5 rounded-xl text-[13px] font-medium "
        classes += "bg-brand text-white" if key == active else "text-slate-500"
        return f'<a href="{href}" class="{classes}">{label}</a>'

    links = "\n    ".join([
        link("/", "Trang chủ", "dashboard"),
        link("/add", "Nhập", "add"),
        link("/transactions", "Danh sách", "list"),
        link("/summary", "Tổng quan", "summary"),
        link("/budgets", "Ngân sách", "budgets"),
        link("/goals", "Mục tiêu", "goals"),
        link("/rules", "Luật", "rules"),
    ])
    return f"""<nav class="max-w-lg mx-auto px-4 pt-5 pb-1">
  <div class="flex flex-wrap gap-1.5 bg-white rounded-2xl p-1.5 shadow-sm ring-1 ring-slate-900/5">
    {links}
  </div>
</nav>"""


# Shared error banner for forms that redirect back to themselves on
# validation failure (goals_new, events_new, simulate_page, budgets_page) —
# `error` is passed as a plain query-param string, not session-based flash,
# matching this app's existing "prefill via query params on redirect" idiom.
ERROR_BANNER = """{% if error %}
  <div class="bg-rose-50 text-rose-700 rounded-2xl p-3 mb-3 text-[13px] font-medium">{{ error }}</div>
  {% endif %}"""


PAGE_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Sổ tài chính</title>
<style>""" + BASE_STYLE + """
  label.field-label {
    display: block;
    font-size: 0.9rem;
    color: #555;
    margin: 16px 0 6px;
  }
  select, input[type="text"] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
    background: #fff;
  }
  .segmented {
    display: flex;
    gap: 8px;
  }
  .segmented input { display: none; }
  .segmented label {
    flex: 1;
    text-align: center;
    padding: 14px 0;
    border-radius: 10px;
    border: 1px solid #d1d1d6;
    font-weight: 600;
    font-size: 1rem;
    user-select: none;
  }
  #dir-out:checked + label { background: #ff3b30; color: #fff; border-color: #ff3b30; }
  #dir-in:checked + label { background: #34c759; color: #fff; border-color: #34c759; }
  #dir-transfer:checked + label { background: #007aff; color: #fff; border-color: #007aff; }
  button#save {
    width: 100%;
    margin-top: 22px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
  button#save:disabled { opacity: 0.5; }
  #message {
    margin-top: 14px;
    padding: 12px;
    border-radius: 10px;
    font-size: 0.95rem;
    text-align: center;
    display: none;
  }
  #message.ok { display: block; background: #e6f9ea; color: #1e7a34; }
  #message.error { display: block; background: #fdecea; color: #c0392b; }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Trang chủ</a>
  <a href="/add" class="active">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng quan</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
  <a href="/rules">Luật</a>
  <a href="/budgets">Ngân sách</a>
  <a href="/goals">Mục tiêu</a>
</div>
<div class="card">
  <h1>Thêm giao dịch</h1>
  <form id="tx-form">
    <div class="segmented">
      <input type="radio" id="dir-out" name="direction" value="out" checked>
      <label for="dir-out">Chi tiền</label>
      <input type="radio" id="dir-in" name="direction" value="in">
      <label for="dir-in">Thu tiền</label>
      <input type="radio" id="dir-transfer" name="direction" value="transfer">
      <label for="dir-transfer">Chuyển khoản</label>
    </div>

    <label class="field-label" for="account" id="account-label">Tài khoản</label>
    <select id="account" required></select>

    <div id="to-account-wrap" style="display:none;">
      <label class="field-label" for="to_account">Đến tài khoản</label>
      <select id="to_account"></select>
    </div>

    <div id="category-wrap">
      <label class="field-label" for="category">Danh mục</label>
      <select id="category"></select>
    </div>

    <label class="field-label" for="amount">Số tiền (đ)</label>
    <input type="text" inputmode="numeric" id="amount" placeholder="0" required>

    <label class="field-label" for="description">Mô tả</label>
    <input type="text" id="description" placeholder="VD: Ăn trưa Highlands">

    <button type="submit" id="save">Lưu</button>
    <div id="message"></div>
  </form>
</div>

<script>
  const accounts = {{ accounts|tojson }};
  const categoriesByKind = {{ categories_by_kind|tojson }};

  const accountSelect = document.getElementById("account");
  const toAccountSelect = document.getElementById("to_account");
  const accountLabel = document.getElementById("account-label");
  const toAccountWrap = document.getElementById("to-account-wrap");
  const categoryWrap = document.getElementById("category-wrap");
  const categorySelect = document.getElementById("category");
  const amountInput = document.getElementById("amount");
  const descriptionInput = document.getElementById("description");
  const form = document.getElementById("tx-form");
  const saveBtn = document.getElementById("save");
  const message = document.getElementById("message");
  let messageTimer = null;

  function formatVND(n) {
    return new Intl.NumberFormat("vi-VN").format(n);
  }

  function renderAccounts() {
    const selected = accountSelect.value;
    const toSelected = toAccountSelect.value;
    accountSelect.innerHTML = "";
    toAccountSelect.innerHTML = "";
    for (const acc of accounts) {
      const label = `${acc.name} (${formatVND(acc.balance)} đ)`;
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = label;
      accountSelect.appendChild(opt);
      const toOpt = document.createElement("option");
      toOpt.value = acc.id;
      toOpt.textContent = label;
      toAccountSelect.appendChild(toOpt);
    }
    if (selected) accountSelect.value = selected;
    if (toSelected) toAccountSelect.value = toSelected;
  }

  function renderCategories(kind) {
    categorySelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Chưa phân loại --";
    categorySelect.appendChild(placeholder);

    for (const parent of categoriesByKind[kind]) {
      if (parent.children.length === 0) {
        const opt = document.createElement("option");
        opt.value = parent.id;
        opt.textContent = parent.name;
        categorySelect.appendChild(opt);
      } else {
        const group = document.createElement("optgroup");
        group.label = parent.name;
        for (const child of parent.children) {
          const opt = document.createElement("option");
          opt.value = child.id;
          opt.textContent = child.name;
          group.appendChild(opt);
        }
        categorySelect.appendChild(group);
      }
    }
  }

  function currentKind() {
    return document.querySelector('input[name="direction"]:checked').value === "out"
      ? "expense"
      : "income";
  }

  function updateFormForDirection() {
    const direction = document.querySelector('input[name="direction"]:checked').value;
    if (direction === "transfer") {
      accountLabel.textContent = "Từ tài khoản";
      toAccountWrap.style.display = "";
      categoryWrap.style.display = "none";
    } else {
      accountLabel.textContent = "Tài khoản";
      toAccountWrap.style.display = "none";
      categoryWrap.style.display = "";
      renderCategories(currentKind());
    }
  }

  document.querySelectorAll('input[name="direction"]').forEach((el) => {
    el.addEventListener("change", updateFormForDirection);
  });

  // Best-effort, NON-authoritative mirror of transaction.parse_amount_vnd —
  // only used here to drive the "amount looks empty/too small" pre-check and
  // the >=1,000,000đ simulate-prompt trigger. The server's parse_amount_vnd
  // is what actually decides the saved amount; this never needs to be exact.
  function tryParseAmount(text) {
    const raw = (text || "").trim().toLowerCase().replace(/\\s+/g, "");
    if (!raw) return null;
    const trailingDigit = raw.match(/^(\\d+)(tr|trieu|triệu)(\\d)$/);
    if (trailingDigit) {
      return Math.round((Number(trailingDigit[1]) + Number(trailingDigit[3]) / 10) * 1000000);
    }
    const unitMatch = raw.match(/^(\\d+(?:[.,]\\d+)?)(k|nghin|nghìn|tr|trieu|triệu|ty|tỷ)$/);
    if (unitMatch) {
      const mult = { k: 1e3, nghin: 1e3, "nghìn": 1e3, tr: 1e6, trieu: 1e6, "triệu": 1e6, ty: 1e9, "tỷ": 1e9 }[unitMatch[2]];
      return Math.round(parseFloat(unitMatch[1].replace(",", ".")) * mult);
    }
    const digits = raw.replace(/[.,]/g, "");
    return /^\\d+$/.test(digits) ? parseInt(digits, 10) : null;
  }

  // Reformats live to "1.234.567" while the field is pure digits (the
  // common case, nice for a numeric keypad) — but pauses the moment a
  // letter shows up, so someone typing Vietnamese shorthand like "1tr" or
  // "500k" gets to finish typing it instead of having every keystroke
  // stripped down to just the leading digit (previously: typing "1tr" was
  // silently recorded as "1" — 1 đồng instead of 1,000,000 — with no
  // warning at all, confirmed live before this fix).
  amountInput.addEventListener("input", () => {
    if (/[a-zA-Z]/.test(amountInput.value)) return;
    const digits = amountInput.value.replace(/\\D/g, "");
    amountInput.value = digits ? formatVND(Number(digits)) : "";
  });

  function showMessage(text, ok) {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.className = ok ? "ok" : "error";
    messageTimer = setTimeout(() => { message.className = ""; }, 4000);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const direction = document.querySelector('input[name="direction"]:checked').value;
    const rawAmount = amountInput.value.trim();
    const previewAmount = tryParseAmount(rawAmount);

    if (!rawAmount || (previewAmount !== null && previewAmount <= 0)) {
      showMessage("Vui lòng nhập số tiền hợp lệ.", false);
      return;
    }

    if (direction === "transfer" && accountSelect.value === toAccountSelect.value) {
      showMessage("Tài khoản nguồn và đích phải khác nhau.", false);
      return;
    }

    if (direction === "out" && previewAmount !== null && previewAmount >= 1000000) {
      const wantsToSimulate = confirm(
        `Khoản chi ${formatVND(previewAmount)} đ khá lớn. Bạn có muốn mô phỏng tác động trước khi lưu không?`
      );
      if (wantsToSimulate) {
        const params = new URLSearchParams({ amount: previewAmount, name: descriptionInput.value || "" });
        window.location.href = "/simulate?" + params.toString();
        return;
      }
    }

    saveBtn.disabled = true;
    try {
      const endpoint = direction === "transfer" ? "/api/transactions/transfer" : "/api/transactions";
      const body = direction === "transfer"
        ? {
            from_account_id: accountSelect.value,
            to_account_id: toAccountSelect.value,
            amount: rawAmount,
            description: descriptionInput.value,
          }
        : {
            direction: direction,
            account_id: accountSelect.value,
            category_id: categorySelect.value,
            amount: rawAmount,
            description: descriptionInput.value,
          };
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      showMessage(data.message, data.ok);
      if (data.ok) {
        // Keep the account dropdown balance labels current across several
        // entries in a row within the same page load — previously these
        // froze at whatever they were on page load, so logging 2-3
        // transactions back to back showed an increasingly stale balance.
        if (previewAmount !== null) {
          if (direction === "transfer") {
            const fromAcc = accounts.find((a) => String(a.id) === String(accountSelect.value));
            const toAcc = accounts.find((a) => String(a.id) === String(toAccountSelect.value));
            if (fromAcc) fromAcc.balance -= previewAmount;
            if (toAcc) toAcc.balance += previewAmount;
          } else {
            const acc = accounts.find((a) => String(a.id) === String(accountSelect.value));
            if (acc) acc.balance += direction === "in" ? previewAmount : -previewAmount;
          }
          renderAccounts();
        }
        amountInput.value = "";
        descriptionInput.value = "";
        amountInput.focus();
      }
    } catch (err) {
      showMessage("Không kết nối được với máy chủ.", false);
    } finally {
      saveBtn.disabled = false;
    }
  });

  renderAccounts();
  updateFormForDirection();
</script>
</body>
</html>
"""


LIST_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Danh sách giao dịch</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("list") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  {% if import_summary %}
  <div class="bg-emerald-50 text-emerald-700 rounded-2xl p-3 mb-3 text-[13px] font-medium">{{ import_summary }}</div>
  {% endif %}
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-3">{{ transactions|length }} giao dịch gần đây</h1>

  {% if transactions %}
  <div class="space-y-3">
    {% for tx in transactions %}
    <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[15px] font-medium text-slate-900 truncate">{{ tx.category_name }}</p>
          <p class="text-[13px] text-slate-500 mt-0.5 truncate">{{ tx.occurred_at }} · {{ tx.account_name }}{% if tx.description %} · {{ tx.description }}{% endif %}</p>
        </div>
        <p class="text-lg font-bold whitespace-nowrap {{ 'text-emerald-600' if tx.sign_class == 'in' else 'text-rose-600' }}">{{ tx.amount_display }}</p>
      </div>
      <div class="flex gap-2 mt-3">
        <a href="/transactions/{{ tx.id }}/edit" class="flex-1 text-center py-2.5 rounded-xl bg-slate-100 text-slate-700 text-[13px] font-medium active:bg-slate-200">Sửa</a>
        <form method="post" action="/transactions/{{ tx.id }}/delete" class="flex-1" onsubmit="return confirm('Xóa giao dịch này? Số dư tài khoản sẽ được cập nhật lại. Không thể hoàn tác.');">
          <button type="submit" class="w-full py-2.5 rounded-xl bg-rose-50 text-rose-600 text-[13px] font-medium active:bg-rose-100">Xóa</button>
        </form>
      </div>
    </div>
    {% endfor %}
  </div>
  {% if has_more %}
  <p class="text-center mt-4"><a href="/transactions?limit={{ next_limit }}" class="text-[13px] text-brand font-medium">Xem thêm giao dịch cũ hơn</a></p>
  {% endif %}
  {% else %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-8 text-center text-slate-400 text-sm">Chưa có giao dịch nào.</div>
  {% endif %}

  <p class="text-center mt-4">
    <a href="/simulate" class="text-[13px] text-slate-400">Mô phỏng một khoản chi lớn →</a>
    ·
    <a href="/transactions/export.csv" class="text-[13px] text-slate-400">Xuất CSV toàn bộ giao dịch</a>
  </p>
</main>
</body>
</html>
"""


SUMMARY_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Tổng quan</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("summary") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-3">Tháng {{ month_display }}</h1>

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-5">
    <div class="flex items-center justify-between py-2">
      <span class="text-[15px] text-slate-600">Thu nhập</span>
      <span class="text-lg font-bold text-emerald-600">{{ income_display }}</span>
    </div>
    <div class="flex items-center justify-between py-2">
      <span class="text-[15px] text-slate-600">Chi tiêu</span>
      <span class="text-lg font-bold text-rose-600">{{ expense_display }}</span>
    </div>
    <div class="flex items-center justify-between pt-3 mt-1 border-t border-slate-100">
      <span class="text-[15px] font-medium text-slate-900">Chênh lệch</span>
      <span class="text-xl font-bold {{ 'text-emerald-600' if diff_positive else 'text-rose-600' }}">{{ diff_display }}</span>
    </div>
  </div>

  <h2 class="text-sm font-medium text-slate-500 px-1 mt-6 mb-3">Số dư tài khoản</h2>
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 divide-y divide-slate-100">
    {% for acc in accounts %}
    <div class="flex items-center justify-between px-5 py-4">
      <span class="text-[15px] text-slate-600">{{ acc.name }}</span>
      <span class="text-[15px] font-semibold text-slate-900">{{ acc.balance_display }}</span>
    </div>
    {% endfor %}
  </div>
</main>
</body>
</html>
"""


RULES_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Luật phân loại</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("rules") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-1">{{ rules|length }} luật phân loại tự động</h1>
  <p class="text-[13px] text-slate-400 px-1 mb-3">Khi mô tả giao dịch chứa một từ khóa dưới đây, danh mục sẽ tự động được gán.</p>

  {% if rules %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 divide-y divide-slate-100">
    {% for rule in rules %}
    <div class="p-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[15px] font-medium text-slate-900 truncate">"{{ rule.pattern }}" → {{ rule.category_name }}</p>
        <p class="text-[13px] text-slate-500 mt-0.5">Ưu tiên {{ rule.priority }} · Đã dùng {{ rule.hit_count }} lần · {{ 'Tự học từ chỉnh sửa' if rule.created_from == 'learned' else 'Tự đặt' }}</p>
      </div>
      <form method="post" action="/rules/{{ rule.id }}/delete" onsubmit="return confirm('Xóa luật này?');">
        <button type="submit" class="px-4 py-2.5 rounded-xl bg-rose-50 text-rose-600 text-[13px] font-medium whitespace-nowrap active:bg-rose-100">Xóa</button>
      </form>
    </div>
    {% endfor %}
  </div>
  {% else %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-8 text-center text-slate-400 text-sm">Chưa có luật nào. Luật sẽ tự học khi bạn sửa danh mục một giao dịch ở trang Danh sách.</div>
  {% endif %}
</main>
</body>
</html>
"""


BUDGETS_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Ngân sách theo kỳ</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("budgets") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <div class="flex items-center justify-between px-1 mb-3">
    <a href="/budgets?period={{ prev_period }}" class="text-slate-400 text-sm px-2 py-1">‹</a>
    <div class="text-center">
      <p class="text-sm font-medium text-slate-700">Kỳ {{ period_id }}</p>
      <p class="text-[12px] text-slate-400">{{ period_range_display }}</p>
    </div>
    <a href="/budgets?period={{ next_period }}" class="text-slate-400 text-sm px-2 py-1">›</a>
  </div>
  """ + ERROR_BANNER + """

  {% if goal_contribution_display %}
  <div class="bg-slate-100 rounded-2xl p-3 mb-3 text-[12px] text-slate-600">
    Mục tiêu của bạn cần để dành <span class="font-semibold">{{ goal_contribution_display }}</span>/kỳ.
    Tổng ngân sách bạn đã đặt cho kỳ này: <span class="font-semibold">{{ total_budgeted_display }}</span>.
    Hãy cân nhắc để ngân sách vẫn còn chỗ cho mục tiêu.
  </div>
  {% endif %}

  <div id="ai-panel" class="bg-indigo-50 rounded-2xl p-4 mb-4 text-[13px] text-indigo-900 hidden"></div>

  <form method="post" action="/budgets/save">
    <input type="hidden" name="period_id" value="{{ period_id }}">
    <div class="space-y-3">
      {% for row in rows %}
      <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
        <div class="flex items-center justify-between gap-3 mb-2">
          <span class="text-[15px] font-medium text-slate-900">{{ row.name }}</span>
          <div class="flex items-center gap-1">
            <input type="text" inputmode="numeric" name="amount_{{ row.id }}" value="{{ row.amount_value }}"
                   placeholder="0" class="w-28 text-right text-[15px] font-semibold border border-slate-200 rounded-lg px-2 py-1.5">
            <span class="text-[13px] text-slate-400">đ</span>
          </div>
        </div>
        {% if row.is_suggestion %}
        <p class="text-[12px] text-brand mb-2">Gợi ý theo công thức — bấm Lưu để chốt, hoặc sửa số trước khi lưu.</p>
        {% endif %}
        {% if row.has_budget %}
        <div class="flex items-center justify-between text-[12px] text-slate-500 mb-1">
          <span>Đã chi {{ row.spent_display }}</span>
          {% if row.over_budget %}<span class="text-rose-600 font-medium">Vượt ngân sách</span>{% endif %}
        </div>
        <div class="bg-slate-100 rounded-full h-2 overflow-hidden">
          <div class="{{ row.bar_color }} h-full rounded-full" style="width: {{ row.pct_used }}%;"></div>
        </div>
        {% endif %}
      </div>
      {% endfor %}
    </div>
    <button type="submit" class="w-full mt-4 py-3.5 rounded-xl bg-brand text-white font-medium">Lưu ngân sách</button>
  </form>
</main>
<script>
  const aiPanel = document.getElementById("ai-panel");
  fetch("/api/ai/budget-suggestion?period={{ period_id }}")
    .then((r) => r.json())
    .then((result) => {
      if (!result.available || !result.data) return;
      const d = result.data;
      let html = '<p class="font-semibold mb-1">Nhận xét từ AI</p>';
      html += `<p class="mb-2">${d.summary}</p>`;
      if (d.adjustments && d.adjustments.length) {
        html += '<ul class="space-y-1 list-disc list-inside">';
        for (const a of d.adjustments) {
          html += `<li>${a.reason}</li>`;
        }
        html += "</ul>";
      }
      aiPanel.innerHTML = html;
      aiPanel.classList.remove("hidden");
    })
    .catch(() => {});
</script>
</body>
</html>
"""


GOALS_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Mục tiêu tài chính</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <div class="flex items-center justify-between px-1 mb-3">
    <h1 class="text-sm font-medium text-slate-500">{{ rows|length }} mục tiêu đang chạy</h1>
    <a href="/goals/new" class="text-brand text-sm font-medium">+ Tạo mục tiêu</a>
  </div>

  {% if show_ai_panel %}
  <div id="ai-panel" class="bg-indigo-50 rounded-2xl p-4 mb-4 text-[13px] text-indigo-900 hidden"></div>
  {% endif %}

  {% if rows %}
  <div class="space-y-3">
    {% for g in rows %}
    <a href="/goals/{{ g.id }}" class="block bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[15px] font-medium text-slate-900">{{ g.name }}</span>
        <span class="text-[12px] text-slate-400">{{ g.type_label }}</span>
      </div>
      <div class="flex items-center justify-between text-[13px] text-slate-500 mb-2">
        <span>{{ g.current_display }} / {{ g.target_display }}</span>
        <span>Hạn {{ g.deadline }}</span>
      </div>
      <div class="bg-slate-100 rounded-full h-2 overflow-hidden mb-1">
        <div class="{{ 'bg-rose-500' if g.is_overdue else ('bg-amber-500' if g.is_off_track else 'bg-emerald-500') }} h-full rounded-full" style="width: {{ g.progress_pct }}%;"></div>
      </div>
      <div class="text-[12px] {{ 'text-rose-600' if (g.is_overdue or g.is_off_track) else 'text-slate-400' }}">
        {% if g.is_overdue %}Đã quá hạn, còn thiếu {{ g.remaining_display }}
        {% elif g.is_off_track %}Đang chậm hơn tiến độ — cần {{ g.required_per_period_display }}/kỳ trong {{ g.periods_remaining }} kỳ còn lại
        {% else %}Cần {{ g.required_per_period_display }}/kỳ, còn {{ g.periods_remaining }} kỳ{% endif %}
      </div>
    </a>
    {% endfor %}
  </div>
  {% else %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-8 text-center text-slate-400 text-sm">Chưa có mục tiêu nào. Bấm "+ Tạo mục tiêu" để bắt đầu.</div>
  {% endif %}

  <p class="text-center mt-4"><a href="/events" class="text-[13px] text-slate-400">Xem kế hoạch sự kiện →</a></p>
</main>
{% if show_ai_panel %}
<script>
  const aiPanel = document.getElementById("ai-panel");
  fetch("/api/ai/goal-priority")
    .then((r) => r.json())
    .then((result) => {
      if (!result.available || !result.data) return;
      const d = result.data;
      let html = '<p class="font-semibold mb-1">Nhận xét từ AI</p>';
      html += `<p class="mb-2">${d.summary}</p>`;
      if (d.priorities && d.priorities.length) {
        const sorted = [...d.priorities].sort((a, b) => a.priority_rank - b.priority_rank);
        html += '<ul class="space-y-1 list-decimal list-inside">';
        for (const p of sorted) {
          html += `<li>${p.reason}</li>`;
        }
        html += "</ul>";
      }
      aiPanel.innerHTML = html;
      aiPanel.classList.remove("hidden");
    })
    .catch(() => {});
</script>
{% endif %}
</body>
</html>
"""


GOALS_NEW_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Tạo mục tiêu</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-3">Tạo mục tiêu mới</h1>
  """ + ERROR_BANNER + """
  <form method="post" class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 space-y-4">
    {% if prefill_event_plan_id %}<input type="hidden" name="event_plan_id" value="{{ prefill_event_plan_id }}">{% endif %}
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Tên mục tiêu</label>
      <input type="text" name="name" required value="{{ prefill_name }}" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Loại mục tiêu</label>
      <select id="goal_type" name="goal_type" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
        {% for t in goal_types %}<option value="{{ t.value }}">{{ t.label }}</option>{% endfor %}
      </select>
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Số tiền đích (đ)</label>
      <input type="text" inputmode="numeric" id="target_amount" name="target_amount" required value="{{ prefill_target }}" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
      {% if emergency_fund_suggestion_display %}
      <p class="text-[12px] text-brand mt-1">Gợi ý cho Quỹ khẩn cấp: {{ emergency_fund_suggestion_display }} (6 lần chi phí thiết yếu 1 kỳ)</p>
      {% endif %}
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Hạn chót</label>
      <input type="date" name="deadline" required min="{{ today }}" value="{{ prefill_deadline }}" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Tài khoản gắn với mục tiêu</label>
      <select name="account_id" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
        {% for acc in accounts %}<option value="{{ acc.id }}">{{ acc.name }}</option>{% endfor %}
      </select>
    </div>
    <button type="submit" class="w-full py-3.5 rounded-xl bg-brand text-white font-medium">Tạo mục tiêu</button>
  </form>
</main>
<script>
  const goalTypeSelect = document.getElementById("goal_type");
  const targetInput = document.getElementById("target_amount");
  const emergencySuggestion = {{ emergency_fund_suggestion }};
  goalTypeSelect.addEventListener("change", () => {
    if (goalTypeSelect.value === "emergency_fund" && emergencySuggestion && !targetInput.value) {
      targetInput.value = emergencySuggestion;
    }
  });
</script>
</body>
</html>
"""


GOAL_DETAIL_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>{{ goal.name }}</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <a href="/goals" class="text-[13px] text-slate-400 px-1">‹ Mục tiêu</a>
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-5 mt-2">
    <div class="flex items-center justify-between mb-1">
      <h1 class="text-lg font-semibold">{{ goal.name }}</h1>
      <span class="text-[12px] text-slate-400">{{ goal.type_label }}</span>
    </div>
    <p class="text-[13px] text-slate-500 mb-3">Tài khoản: {{ goal.account_name }} · Hạn: {{ goal.deadline }}</p>

    <div class="flex items-center justify-between text-[15px] font-semibold mb-2">
      <span>{{ goal.current_display }}</span>
      <span class="text-slate-400 font-normal">/ {{ goal.target_display }}</span>
    </div>
    <div class="bg-slate-100 rounded-full h-2.5 overflow-hidden mb-3">
      <div class="{{ 'bg-rose-500' if goal.is_overdue else ('bg-amber-500' if goal.is_off_track else 'bg-emerald-500') }} h-full rounded-full" style="width: {{ goal.progress_pct }}%;"></div>
    </div>

    {% if goal.is_overdue %}
    <p class="text-[13px] text-rose-600 font-medium">Đã quá hạn — còn thiếu {{ goal.remaining_display }}.</p>
    {% elif goal.is_off_track %}
    <p class="text-[13px] text-rose-600 font-medium">Đang chậm hơn tiến độ dự kiến.</p>
    {% else %}
    <p class="text-[13px] text-emerald-600 font-medium">Đang đúng tiến độ.</p>
    {% endif %}

    <div class="grid grid-cols-2 gap-3 mt-4">
      <div class="bg-slate-50 rounded-xl p-3">
        <p class="text-[12px] text-slate-400">Còn thiếu</p>
        <p class="text-[15px] font-semibold">{{ goal.remaining_display }}</p>
      </div>
      <div class="bg-slate-50 rounded-xl p-3">
        <p class="text-[12px] text-slate-400">Kỳ còn lại</p>
        <p class="text-[15px] font-semibold">{{ goal.periods_remaining }} kỳ</p>
      </div>
    </div>
    <div class="bg-slate-50 rounded-xl p-3 mt-3">
      <p class="text-[12px] text-slate-400">Cần để dành mỗi kỳ</p>
      <p class="text-[15px] font-semibold">{{ goal.required_per_period_display }}</p>
    </div>

    <form method="post" action="/goals/{{ goal.id }}/deactivate" class="mt-4"
          onsubmit="return confirm('Ẩn mục tiêu này? Dùng khi đã hoàn thành hoặc không theo đuổi nữa — không xóa lịch sử, chỉ ẩn khỏi danh sách Mục tiêu.');">
      <button type="submit" class="w-full py-2.5 rounded-xl bg-slate-100 text-slate-500 text-[13px] font-medium">Ẩn mục tiêu này (đã hoàn thành / không theo đuổi nữa)</button>
    </form>
  </div>
</main>
</body>
</html>
"""


EVENTS_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Kế hoạch sự kiện</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <div class="flex items-center justify-between px-1 mb-3">
    <h1 class="text-sm font-medium text-slate-500">{{ rows|length }} kế hoạch sự kiện</h1>
    <a href="/events/new" class="text-brand text-sm font-medium">+ Tạo kế hoạch</a>
  </div>
  {% if rows %}
  <div class="space-y-3">
    {% for p in rows %}
    <a href="/events/{{ p.id }}" class="block bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[15px] font-medium text-slate-900">{{ p.name }}</span>
        <span class="text-lg font-bold text-slate-900">{{ p.total_display }}</span>
      </div>
      <p class="text-[13px] text-slate-500">{{ p.item_count }} khoản mục · Ngày: {{ p.event_date }}{% if p.linked_goal_id %} · Đã liên kết mục tiêu{% endif %}</p>
    </a>
    {% endfor %}
  </div>
  {% else %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-8 text-center text-slate-400 text-sm">Chưa có kế hoạch sự kiện nào.</div>
  {% endif %}
</main>
</body>
</html>
"""


EVENTS_NEW_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Tạo kế hoạch sự kiện</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-3">Tạo kế hoạch sự kiện</h1>
  """ + ERROR_BANNER + """

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 mb-3">
    <p class="text-[13px] text-slate-500 mb-2">Chọn mẫu có sẵn (chỉ gợi ý khoản mục, giá do bạn tự nhập):</p>
    <div class="flex flex-wrap gap-2">
      <a href="/events/new" class="px-3 py-1.5 rounded-lg text-[13px] {{ 'bg-brand text-white' if not selected_template_id else 'bg-slate-100 text-slate-600' }}">Tự tạo</a>
      {% for t in templates %}
      <a href="/events/new?template={{ t.id }}" class="px-3 py-1.5 rounded-lg text-[13px] {{ 'bg-brand text-white' if selected_template_id == t.id|string else 'bg-slate-100 text-slate-600' }}">{{ t.name }}</a>
      {% endfor %}
    </div>
  </div>

  <form method="post" class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 space-y-4">
    {% if selected_template_id %}<input type="hidden" name="template_id" value="{{ selected_template_id }}">{% endif %}
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Tên kế hoạch</label>
      <input type="text" name="name" required value="{{ prefill_name }}" placeholder="VD: Chuyển nhà tháng 9" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Ngày diễn ra (nếu biết)</label>
      <input type="date" name="event_date" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>

    <div class="border-t border-slate-100 pt-3">
      <p class="text-[13px] text-slate-500 mb-2">Khoản mục (để trống số tiền để bỏ qua khoản đó):</p>
      <div class="space-y-2">
        {% for item in template_items %}
        <div class="flex items-center gap-2">
          <input type="hidden" name="item_name_{{ loop.index0 }}" value="{{ item.name }}">
          <span class="flex-1 text-[14px] text-slate-700">{{ item.name }}</span>
          <input type="text" inputmode="numeric" name="item_amount_{{ loop.index0 }}" placeholder="0" class="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 text-[14px]">
        </div>
        {% endfor %}
        {% for i in range(5) %}
        <div class="flex items-center gap-2">
          <input type="text" name="item_name_extra_{{ i }}" placeholder="Khoản mục khác" class="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-[14px]">
          <input type="text" inputmode="numeric" name="item_amount_extra_{{ i }}" placeholder="0" class="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 text-[14px]">
        </div>
        {% endfor %}
      </div>
    </div>

    <button type="submit" class="w-full py-3.5 rounded-xl bg-brand text-white font-medium">Tạo kế hoạch</button>
  </form>
</main>
</body>
</html>
"""


EVENT_DETAIL_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>{{ plan.name }}</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("goals") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <a href="/events" class="text-[13px] text-slate-400 px-1">‹ Kế hoạch sự kiện</a>
  """ + ERROR_BANNER + """

  {% if show_goal_prompt %}
  <div class="bg-indigo-50 rounded-2xl p-4 my-3 text-[13px] text-indigo-900">
    <p class="mb-2">Kế hoạch này có tổng dự kiến {{ total_display }}{% if plan.event_date %}, diễn ra {{ plan.event_date }}{% endif %} — bạn có muốn tạo một mục tiêu tích lũy tương ứng không?</p>
    <div class="flex gap-2">
      <a href="/goals/new?name={{ plan.name | urlencode }}&target_amount={{ total_amount }}&deadline={{ plan.event_date }}&event_plan_id={{ plan.id }}" class="flex-1 text-center py-2 rounded-lg bg-brand text-white text-[13px] font-medium">Tạo mục tiêu</a>
      <form method="post" action="/events/{{ plan.id }}/dismiss-goal-prompt" class="flex-1">
        <button type="submit" class="w-full py-2 rounded-lg bg-white text-slate-500 text-[13px] font-medium">Không, cảm ơn</button>
      </form>
    </div>
  </div>
  {% endif %}

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-5 mt-2">
    <div class="flex items-center justify-between mb-3">
      <h1 class="text-lg font-semibold">{{ plan.name }}</h1>
      <span class="text-lg font-bold">{{ total_display }}</span>
    </div>
    {% if plan.event_date %}<p class="text-[13px] text-slate-500 mb-3">Ngày diễn ra: {{ plan.event_date }}</p>{% endif %}

    {% if items %}
    <div class="divide-y divide-slate-100">
      {% for item in items %}
      <div class="flex items-center justify-between py-2 text-[14px]">
        <span class="text-slate-700">{{ item.name }}</span>
        <span class="font-medium">{{ item.expected_display }}</span>
      </div>
      {% endfor %}
    </div>
    {% else %}
    <p class="text-slate-400 text-sm">Chưa có khoản mục nào.</p>
    {% endif %}
  </div>
</main>
</body>
</html>
"""


SIMULATE_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Mô phỏng chi tiêu</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("simulate") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <div class="flex items-center justify-between px-1 mb-3">
    <h1 class="text-sm font-medium text-slate-500">Mô phỏng một khoản chi</h1>
    <a href="/simulations" class="text-brand text-sm font-medium">Lịch sử</a>
  </div>
  """ + ERROR_BANNER + """

  <form method="post" class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 space-y-4">
    {% if triggered_by %}<input type="hidden" name="triggered_by_transaction_id" value="{{ triggered_by }}">{% endif %}
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Khoản chi dự tính</label>
      <input type="text" name="name" required value="{{ prefill_name }}" placeholder="VD: Mua laptop mới" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Số tiền (đ) — hỗ trợ viết tắt như 500k, 1tr, 2tr5</label>
      <input type="text" inputmode="numeric" id="item_amount" name="item_amount" required value="{{ prefill_amount }}" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>

    <div id="big-item-fields" class="space-y-4 hidden">
      <p class="text-[12px] text-slate-400">Khoản chi lớn — cho biết thêm để tính tổng chi phí sở hữu:</p>
      <div>
        <label class="block text-[13px] text-slate-500 mb-1">Chi phí duy trì mỗi kỳ (nếu có)</label>
        <input type="text" inputmode="numeric" name="maintenance_cost_per_period" value="{{ prefill_maintenance }}" placeholder="0" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
      </div>
      <div>
        <label class="block text-[13px] text-slate-500 mb-1">Tuổi thọ dự kiến (số kỳ)</label>
        <input type="text" inputmode="numeric" name="expected_lifetime_periods" value="{{ prefill_lifetime }}" placeholder="0" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
      </div>
    </div>

    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Ghi chú (tùy chọn)</label>
      <input type="text" name="note" placeholder="VD: mô phỏng chuyển nhà" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
    </div>

    <button type="submit" class="w-full py-3.5 rounded-xl bg-brand text-white font-medium">Xem tác động</button>
  </form>
</main>
<script>
  const amountInput = document.getElementById("item_amount");
  const bigFields = document.getElementById("big-item-fields");
  // Best-effort mirror of transaction.parse_amount_vnd, just for deciding
  // whether to reveal the "big item" fields below — the server's own parse
  // is what actually matters for what gets saved, so this only needs to be
  // close enough to recognize shorthand like "1tr" as >= 1,000,000.
  function tryParseAmount(text) {
    const raw = (text || "").trim().toLowerCase().replace(/\\s+/g, "");
    if (!raw) return 0;
    const trailingDigit = raw.match(/^(\\d+)(tr|trieu|triệu)(\\d)$/);
    if (trailingDigit) {
      return Math.round((Number(trailingDigit[1]) + Number(trailingDigit[3]) / 10) * 1000000);
    }
    const unitMatch = raw.match(/^(\\d+(?:[.,]\\d+)?)(k|nghin|nghìn|tr|trieu|triệu|ty|tỷ)$/);
    if (unitMatch) {
      const mult = { k: 1e3, nghin: 1e3, "nghìn": 1e3, tr: 1e6, trieu: 1e6, "triệu": 1e6, ty: 1e9, "tỷ": 1e9 }[unitMatch[2]];
      return Math.round(parseFloat(unitMatch[1].replace(",", ".")) * mult);
    }
    const digits = raw.replace(/[.,]/g, "");
    return /^\\d+$/.test(digits) ? parseInt(digits, 10) : 0;
  }
  function toggleBigFields() {
    bigFields.classList.toggle("hidden", tryParseAmount(amountInput.value) < 1000000);
  }
  amountInput.addEventListener("input", toggleBigFields);
  toggleBigFields();
</script>
</body>
</html>
"""


SIMULATIONS_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Lịch sử mô phỏng</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("simulate") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <div class="flex items-center justify-between px-1 mb-3">
    <h1 class="text-sm font-medium text-slate-500">{{ rows|length }} mô phỏng đã lưu</h1>
    <a href="/simulate" class="text-brand text-sm font-medium">+ Mô phỏng mới</a>
  </div>
  {% if rows %}
  <div class="space-y-3">
    {% for s in rows %}
    <a href="/simulations/{{ s.id }}" class="block bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[15px] font-medium text-slate-900">{{ s.name }}</span>
        <span class="text-lg font-bold text-slate-900">{{ s.item_amount_display }}</span>
      </div>
      <p class="text-[13px] text-slate-500">{{ s.note }}{% if s.note %} · {% endif %}{{ s.created_at }}</p>
    </a>
    {% endfor %}
  </div>
  {% else %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-8 text-center text-slate-400 text-sm">Chưa có mô phỏng nào.</div>
  {% endif %}
</main>
</body>
</html>
"""


SIMULATION_DETAIL_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<title>{{ name }}</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("simulate") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <a href="/simulations" class="text-[13px] text-slate-400 px-1">‹ Lịch sử mô phỏng</a>

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-5 mt-2">
    <div class="flex items-center justify-between mb-1">
      <h1 class="text-lg font-semibold">{{ name }}</h1>
      <span class="text-lg font-bold">{{ item_amount_display }}</span>
    </div>
    {% if note %}<p class="text-[13px] text-slate-500 mb-3">{{ note }}</p>{% endif %}

    <div class="mt-3">
      <canvas id="balance-chart" height="180"></canvas>
    </div>
    <p class="text-[11px] text-slate-400 text-center mt-1">Số dư dự báo 12 kỳ tới — có và không có khoản chi này (phương án trả thẳng)</p>
  </div>

  <div id="ai-panel" class="bg-indigo-50 rounded-2xl p-4 my-3 text-[13px] text-indigo-900 {% if not ai_recommendation %}hidden{% endif %}">
    {% if ai_recommendation %}
    <p class="font-semibold mb-1">Khuyến nghị từ AI</p>
    <p class="mb-2">{{ ai_recommendation.recommendation }}</p>
    {% if ai_recommendation.scenario_notes %}
    <ul class="space-y-1 list-disc list-inside mb-2">
      {% for n in ai_recommendation.scenario_notes %}
      <li><strong>{{ n.scenario_label }}:</strong> {{ n.pros }} Nhưng {{ n.cons }}</li>
      {% endfor %}
    </ul>
    {% endif %}
    <p class="text-indigo-700">{{ ai_recommendation.summary }}</p>
    {% endif %}
  </div>

  <h2 class="text-sm font-medium text-slate-500 px-1 mb-2 mt-4">So sánh các phương án</h2>
  <div class="space-y-3">
    {% for s in scenarios %}
    <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[15px] font-medium text-slate-900">{{ s.label }}</span>
        <span class="text-[11px] px-2 py-1 rounded-full font-medium {{ s.traffic_color }}">{{ s.traffic_label }}</span>
      </div>
      <p class="text-[13px] text-slate-500">Tổng chi phí sở hữu: {{ s.tco_display }}</p>
    </div>
    {% endfor %}
  </div>
</main>
<script>
  const ctx = document.getElementById("balance-chart");
  if (window.Chart) {
    new Chart(ctx, {
      type: "line",
      data: {
        labels: {{ chart_labels|tojson }},
        datasets: [
          {
            label: "Không có khoản chi này",
            data: {{ chart_baseline|tojson }},
            borderColor: "#64748b",
            borderDash: [4, 4],
            tension: 0.2,
          },
          {
            label: "Có khoản chi này (trả thẳng)",
            data: {{ chart_with_expense|tojson }},
            borderColor: "#007aff",
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { x: { title: { display: true, text: "Kỳ tới" } } },
      },
    });
  }

  {% if not ai_recommendation %}
  const aiPanel = document.getElementById("ai-panel");
  fetch("/api/ai/simulation-advice?simulation_id={{ simulation_id }}")
    .then((r) => r.json())
    .then((result) => {
      if (!result.available || !result.data) return;
      const d = result.data;
      let html = '<p class="font-semibold mb-1">Khuyến nghị từ AI</p>';
      html += `<p class="mb-2">${d.recommendation}</p>`;
      if (d.scenario_notes && d.scenario_notes.length) {
        html += '<ul class="space-y-1 list-disc list-inside mb-2">';
        for (const n of d.scenario_notes) {
          html += `<li><strong>${n.scenario_label}:</strong> ${n.pros} Nhưng ${n.cons}</li>`;
        }
        html += "</ul>";
      }
      html += `<p class="text-indigo-700">${d.summary}</p>`;
      aiPanel.innerHTML = html;
      aiPanel.classList.remove("hidden");
    })
    .catch(() => {});
  {% endif %}
</script>
</body>
</html>
"""


FORECAST_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<title>Dự báo dòng tiền</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("forecast") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3">
  <h1 class="text-sm font-medium text-slate-500 px-1 mb-3">Dự báo dòng tiền</h1>

  {% if has_forecast %}
  {% if scenario == 'macro_adjusted' %}
  <div class="bg-amber-50 rounded-2xl p-4 mb-3 text-[13px] text-amber-900">
    Đây là kịch bản có điều chỉnh theo bối cảnh vĩ mô — xem song song với <a href="/forecast/{{ base_forecast_id }}" class="underline font-medium">dự báo gốc</a>.
  </div>
  {% endif %}

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-5">
    <canvas id="forecast-chart" height="180"></canvas>
    {% if any_danger %}
    <p class="text-[13px] text-rose-600 font-medium mt-2">⚠️ Có kỳ dự báo âm quỹ hoặc chạm ngưỡng nguy hiểm — xem bảng bên dưới.</p>
    {% endif %}
    {% if seasonality_applied %}<p class="text-[12px] text-slate-400 mt-1">Đã áp dụng điều chỉnh mùa vụ.</p>{% endif %}
  </div>

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 divide-y divide-slate-100 mt-3">
    {% for r in rows %}
    <div class="flex items-center justify-between px-4 py-3">
      <div>
        <span class="text-[14px] font-medium text-slate-900">{{ r.period_id }}</span>
        <p class="text-[12px] text-slate-400">Thu {{ r.income_display }} · Chi {{ r.expense_display }}</p>
      </div>
      <span class="text-[15px] font-bold {{ 'text-rose-600' if r.is_danger else 'text-slate-900' }}">{{ r.balance_display }}</span>
    </div>
    {% endfor %}
  </div>
  {% endif %}

  {% if seasonality_has_data and seasonality_patterns %}
  <div class="bg-indigo-50 rounded-2xl p-4 mt-4 text-[13px] text-indigo-900">
    <p class="font-semibold mb-1">Phát hiện quy luật mùa vụ</p>
    {% for p in seasonality_patterns %}
    <p class="mb-1">{{ p.month_label }}: chi tiêu trung bình {{ p.avg_expense_display }}, lệch {{ p.pct_difference }}% so với trung bình chung ({{ p.overall_avg_display }}), dựa trên {{ p.sample_count }} lần quan sát, độ lệch chuẩn {{ p.stdev_display }}.</p>
    {% endfor %}
    <p class="text-[12px] text-indigo-700 mt-1">Tick vào ô "Áp dụng mùa vụ" bên dưới khi tạo dự báo mới nếu muốn dùng thông tin này — hệ thống không tự áp dụng.</p>
  </div>
  {% endif %}

  <h2 class="text-sm font-medium text-slate-500 px-1 mb-2 mt-4">Tạo dự báo mới</h2>
  <form method="post" class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 space-y-4">
    <div>
      <label class="block text-[13px] text-slate-500 mb-1">Số kỳ dự báo</label>
      <select name="periods_ahead" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px]">
        {% for n in periods_ahead_options %}<option value="{{ n }}">{{ n }} kỳ</option>{% endfor %}
      </select>
    </div>

    {% if seasonality_has_data and seasonality_patterns %}
    <label class="flex items-center gap-2 text-[13px] text-slate-600">
      <input type="checkbox" name="apply_seasonality"> Áp dụng quy luật mùa vụ đã phát hiện ở trên
    </label>
    {% endif %}

    <div>
      <p class="text-[13px] text-slate-500 mb-2">Thu nhập thất thường ước tính mỗi kỳ (bỏ trống nếu không có — chỉ số kỳ khớp với lựa chọn "Số kỳ dự báo" ở trên được dùng):</p>
      <div class="grid grid-cols-3 gap-2">
        {% for i in irregular_income_field_range %}
        <input type="text" inputmode="numeric" name="irregular_income_{{ i }}" placeholder="Kỳ {{ i + 1 }}" class="border border-slate-200 rounded-lg px-2 py-2 text-[13px]">
        {% endfor %}
      </div>
    </div>

    <button type="submit" class="w-full py-3.5 rounded-xl bg-brand text-white font-medium">Tạo dự báo</button>
  </form>

  {% if enable_macro_context %}
  <h2 class="text-sm font-medium text-slate-500 px-1 mb-2 mt-4">Bối cảnh tham khảo</h2>
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
    <p class="text-[12px] text-slate-400 mb-3">Thông tin chung của thị trường, KHÔNG PHẢI tư vấn tài chính cá nhân. Không tự động ảnh hưởng tới số dự báo ở trên.</p>
    <button type="button" id="load-macro-btn" class="w-full py-2.5 rounded-xl bg-slate-100 text-slate-700 text-[13px] font-medium">Xem bối cảnh tham khảo</button>
    <div id="macro-panel" class="mt-3 hidden"></div>
    {% if has_forecast and scenario == 'base' %}
    <form id="macro-scenario-form" method="post" action="/forecast/{{ forecast_id }}/macro-scenario" class="mt-3 hidden">
      <label class="block text-[13px] text-slate-500 mb-1">Điều chỉnh thêm mỗi kỳ (đ, có thể để trống)</label>
      <input type="text" inputmode="numeric" name="macro_adjustment" placeholder="0" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-[15px] mb-2">
      <input type="hidden" name="macro_context_note" id="macro_context_note">
      <input type="hidden" name="macro_context_sources" id="macro_context_sources">
      <button type="submit" class="w-full py-2.5 rounded-xl bg-brand text-white text-[13px] font-medium">Tạo kịch bản có điều chỉnh</button>
    </form>
    {% endif %}
  </div>
  <script>
    document.getElementById("load-macro-btn").addEventListener("click", () => {
      const panel = document.getElementById("macro-panel");
      panel.classList.remove("hidden");
      panel.innerHTML = '<p class="text-[13px] text-slate-400">Đang tải...</p>';
      fetch("/api/ai/macro-context")
        .then((r) => r.json())
        .then((result) => {
          if (!result.available || !result.data) {
            panel.innerHTML = '<p class="text-[13px] text-slate-400">Tạm thời chưa có bối cảnh tham khảo.</p>';
            return;
          }
          const d = result.data;
          let html = `<p class="text-[13px] text-slate-700 mb-2">${d.summary}</p>`;
          if (d.sources && d.sources.length) {
            html += '<ul class="text-[11px] text-slate-400 space-y-1">';
            for (const s of d.sources) {
              html += `<li><a href="${s.url}" target="_blank" class="underline">${s.title || s.url}</a></li>`;
            }
            html += "</ul>";
          }
          panel.innerHTML = html;
          const form = document.getElementById("macro-scenario-form");
          if (form) {
            document.getElementById("macro_context_note").value = d.summary;
            document.getElementById("macro_context_sources").value = JSON.stringify(d.sources || []);
            form.classList.remove("hidden");
          }
        })
        .catch(() => { panel.innerHTML = '<p class="text-[13px] text-slate-400">Tạm thời chưa có bối cảnh tham khảo.</p>'; });
    });
  </script>
  {% endif %}
</main>
{% if has_forecast %}
<script>
  new Chart(document.getElementById("forecast-chart"), {
    type: "line",
    data: {
      labels: {{ chart_labels|tojson }},
      datasets: [{
        label: "Số dư dự báo",
        data: {{ chart_balances|tojson }},
        borderColor: "#007aff",
        tension: 0.2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
    },
  });
</script>
{% endif %}
</body>
</html>
"""


DASHBOARD_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
""" + TAILWIND_HEAD + """
<title>Trang chủ</title>
</head>
<body class="bg-slate-50 min-h-screen text-slate-900 font-sans">
""" + tailwind_nav("dashboard") + """
<main class="max-w-lg mx-auto px-4 pb-10 pt-3 space-y-4">

  {% for alert in alerts %}
  <div class="rounded-2xl p-4 flex items-start justify-between gap-3 {{ 'bg-rose-50 text-rose-700' if alert.level == 'danger' else 'bg-amber-50 text-amber-700' }}">
    <p class="text-[13px] font-medium leading-snug">{{ alert.message }}</p>
    <form method="post" action="/alerts/{{ alert.code }}/dismiss">
      <button type="submit" class="text-[12px] font-semibold opacity-70 shrink-0">Đã xem</button>
    </form>
  </div>
  {% endfor %}

  <a href="/risk" class="block rounded-2xl {{ health.color }} p-5 text-white shadow-sm">
    <p class="text-[13px] font-medium opacity-90 mb-1">Điểm sức khỏe tài chính</p>
    <p class="text-2xl font-bold">{{ health.level_label }}</p>
    {% if health.downgraded_reasons %}
    <ul class="mt-2 text-[12px] opacity-90 space-y-0.5">
      {% for reason in health.downgraded_reasons %}
      <li>• {{ reason }}</li>
      {% endfor %}
    </ul>
    {% endif %}
    <p class="text-[12px] opacity-80 mt-2">Xem chi tiết ›</p>
  </a>

  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4 flex items-center justify-between">
    <span class="text-[13px] text-slate-500">Tổng tài sản</span>
    <span class="text-lg font-semibold">{{ net_worth_display }}</span>
  </div>

  <div id="ai-panel" class="bg-indigo-50 rounded-2xl p-4 text-[13px] text-indigo-900 hidden">
    <p class="font-semibold mb-1">Nhận xét từ AI</p>
    <p id="ai-panel-text"></p>
  </div>

  {% if reminders %}
  <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
    <p class="text-[13px] font-medium text-slate-500 mb-2">Kỳ {{ period_id }} · còn {{ days_remaining }} ngày</p>
    <ul class="space-y-1.5 text-[13px] text-slate-700">
      {% for reminder in reminders %}
      <li>• {{ reminder }}</li>
      {% endfor %}
    </ul>
  </div>
  {% endif %}

  {% if goals_summary %}
  <a href="/goals" class="block bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
    <div class="flex items-center justify-between mb-1">
      <span class="text-[13px] font-medium text-slate-500">Mục tiêu</span>
      <span class="text-[12px] text-brand font-medium">Xem tất cả ›</span>
    </div>
    <p class="text-[13px] text-slate-700">{{ goals_summary.on_track_count }}/{{ goals_summary.total }} mục tiêu đúng tiến độ</p>
    {% if goals_summary.most_urgent %}
    <p class="text-[12px] text-rose-600 mt-1">{{ goals_summary.most_urgent.message }}</p>
    {% endif %}
  </a>
  {% endif %}

  {% if nearest_event %}
  <a href="/events/{{ nearest_event.id }}" class="block bg-white rounded-2xl ring-1 ring-slate-900/5 p-4">
    <div class="flex items-center justify-between mb-1">
      <span class="text-[13px] font-medium text-slate-500">Sự kiện sắp tới</span>
      <span class="text-[12px] text-brand font-medium">Xem ›</span>
    </div>
    <p class="text-[13px] text-slate-700">{{ nearest_event.name }} — còn {{ nearest_event.days_remaining }} ngày, dự kiến {{ nearest_event.total_display }}</p>
  </a>
  {% endif %}

  <div class="grid grid-cols-2 gap-3">
    {% for m in metrics %}
    <div class="bg-white rounded-2xl ring-1 ring-slate-900/5 p-3.5">
      <p class="text-[11px] text-slate-400 mb-1">{{ m.label }}</p>
      <p class="text-[14px] font-semibold text-slate-900 leading-snug">{{ m.value }}</p>
    </div>
    {% endfor %}
  </div>

  <a href="/add" class="block w-full py-3.5 rounded-xl bg-brand text-white font-medium text-center">+ Thêm giao dịch</a>
</main>
<script>
  fetch("/api/ai/daily-summary")
    .then((r) => r.json())
    .then((result) => {
      if (!result.available || !result.data) return;
      document.getElementById("ai-panel-text").textContent = result.data.summary;
      document.getElementById("ai-panel").classList.remove("hidden");
    })
    .catch(() => {});
</script>
</body>
</html>
"""


EDIT_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Sửa danh mục</title>
<style>""" + BASE_STYLE + """
  .tx-info { color: #555; font-size: 0.9rem; margin-bottom: 16px; }
  label.field-label {
    display: block;
    font-size: 0.9rem;
    color: #555;
    margin: 16px 0 6px;
  }
  select, input[type="text"] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
    background: #fff;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    font-size: 0.9rem;
    color: #555;
  }
  .checkbox-row input { width: auto; }
  button#save {
    width: 100%;
    margin-top: 22px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Trang chủ</a>
  <a href="/add">Thêm</a>
  <a href="/transactions" class="active">Danh sách</a>
  <a href="/summary">Tổng quan</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
  <a href="/rules">Luật</a>
  <a href="/budgets">Ngân sách</a>
  <a href="/goals">Mục tiêu</a>
</div>
<div class="card">
  <h1>Sửa danh mục</h1>
  <p class="tx-info">{{ tx.occurred_at }} · {{ tx.account_name }} · {{ tx.amount_display }}{% if tx.description %} · {{ tx.description }}{% endif %}</p>
  <form method="post">
    <label class="field-label" for="category_id">Danh mục</label>
    <select id="category_id" name="category_id">
      <option value="">-- Chưa phân loại --</option>
      {% for parent in categories %}
        {% if parent.children %}
          <optgroup label="{{ parent.name }}">
            {% for child in parent.children %}
              <option value="{{ child.id }}" {% if child.id == tx.category_id %}selected{% endif %}>{{ child.name }}</option>
            {% endfor %}
          </optgroup>
        {% else %}
          <option value="{{ parent.id }}" {% if parent.id == tx.category_id %}selected{% endif %}>{{ parent.name }}</option>
        {% endif %}
      {% endfor %}
    </select>

    {% if tx.description %}
    <div class="checkbox-row">
      <input type="checkbox" id="create_rule" name="create_rule" checked>
      <label for="create_rule">Lần sau mô tả chứa từ khóa dưới đây thì tự xếp vào danh mục này</label>
    </div>
    <input type="text" name="pattern" value="{{ tx.description }}">
    {% endif %}

    <button type="submit" id="save">Lưu</button>
  </form>
</div>
</body>
</html>
"""


RISK_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Tình hình tài chính</title>
<style>""" + BASE_STYLE + """
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 22px 0 8px;
  }
  .section-title:first-of-type { margin-top: 4px; }
  .summary-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #eee;
    font-size: 0.95rem;
    gap: 8px;
  }
  .summary-row.total { border-bottom: none; margin-top: 2px; font-size: 1.05rem; font-weight: 600; }
  .summary-row.total.good span:last-child { color: #1e7a34; }
  .summary-row.total.danger span:last-child { color: #c0392b; }
  .note.good { color: #1e7a34; font-weight: 600; }
  .note.warning { color: #c0392b; font-weight: 600; }
  .summary-row span.good { color: #1e7a34; }
  .summary-row span.warning { color: #c0392b; }
  .empty { color: #888; font-size: 0.9rem; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #fff;
  }
  .badge-nguy_hiem { background: #c0392b; }
  .badge-mong_manh { background: #e67e22; }
  .badge-on { background: #2980b9; }
  .badge-vung { background: #1e7a34; }
  .budget-item { margin: 10px 0; }
  .budget-label { display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 4px; }
  .budget-bar-bg { background: #eee; border-radius: 6px; height: 8px; overflow: hidden; }
  .budget-bar-fill { background: #2980b9; height: 100%; }
  .budget-bar-fill.over { background: #c0392b; }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Trang chủ</a>
  <a href="/add">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng quan</a>
  <a href="/risk" class="active">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
  <a href="/rules">Luật</a>
  <a href="/budgets">Ngân sách</a>
  <a href="/goals">Mục tiêu</a>
</div>
<div class="card">
  <h1>Tình hình tài chính</h1>

  <p class="section-title">Dự báo ngắn hạn (còn lại kỳ này)</p>
  <div class="summary-row"><span>Số dư khả dụng</span><span>{{ forecast.liquid_balance_display }}</span></div>
  <div class="summary-row"><span>Khoản định kỳ còn phải trả</span><span>{{ forecast.remaining_recurring_display }}</span></div>
  <div class="summary-row"><span>Chi tiêu dự kiến còn lại</span><span>{{ forecast.projected_spend_display }}</span></div>
  <div class="summary-row total {{ 'danger' if forecast.at_risk else 'good' }}">
    <span>Dự báo cuối kỳ</span><span>{{ forecast.forecast_balance_display }}</span>
  </div>
  {% if forecast.at_risk %}<p class="note warning">⚠️ Có thể âm quỹ cuối kỳ nếu chi tiêu như hiện tại.</p>{% endif %}

  <p class="section-title">Rủi ro thanh khoản</p>
  {% if liquidity.has_data %}
    <div class="summary-row"><span>Tài sản lỏng</span><span>{{ liquidity.liquid_balance_display }}</span></div>
    <div class="summary-row"><span>Chi phí thiết yếu 1 kỳ (ước tính)</span><span>{{ liquidity.essential_monthly_display }}</span></div>
    <p class="note {{ 'good' if liquidity.sufficient else 'warning' }}">
      {{ 'Đủ trang trải 1 kỳ chi phí bắt buộc.' if liquidity.sufficient else '⚠️ Không đủ trang trải 1 kỳ chi phí bắt buộc.' }}
    </p>
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần lịch sử chi tiêu ít nhất 1 kỳ đã qua).</p>
  {% endif %}

  <p class="section-title">Nền móng tài chính</p>
  {% if runway.has_data %}
    <p>Nếu mất thu nhập, tài sản lỏng đủ sống <strong>{{ runway.months_display }} kỳ</strong> —
       <span class="badge badge-{{ runway.level }}">{{ runway.level_label }}</span></p>
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần lịch sử chi tiêu ít nhất 1 kỳ đã qua).</p>
  {% endif %}

  <p class="section-title">Thu nhập ổn định</p>
  {% if margin.has_data %}
    <div class="summary-row"><span>Thu nhập ổn định (đã tính độ tin cậy)</span><span>{{ margin.reliable_income_display }}</span></div>
    <div class="summary-row"><span>Chi phí thiết yếu 1 kỳ</span><span>{{ margin.essential_monthly_display }}</span></div>
    <p class="note {{ 'good' if margin.sufficient else 'warning' }}">
      {{ 'Đủ trang trải' if margin.sufficient else '⚠️ Không đủ trang trải' }} chi phí thiết yếu (chênh lệch {{ margin.margin_display }}).
    </p>
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần khai báo nguồn thu nhập ở CLI menu 10, và có lịch sử chi tiêu).</p>
  {% endif %}

  <p class="section-title">Cân đối 50/30/20 (kỳ {{ period_id }})</p>
  {% if budget.has_income %}
    <div class="summary-row"><span>Thiết yếu (≤ 50%)</span><span>{{ budget.essential_display }} ({{ budget.essential_pct }}%)</span></div>
    <div class="summary-row"><span>Tùy chọn (≤ 30%)</span><span>{{ budget.optional_display }} ({{ budget.optional_pct }}%)</span></div>
    <div class="summary-row"><span>Còn lại (≥ 20%)</span><span>{{ budget.savings_display }} ({{ budget.savings_pct }}%)</span></div>
  {% else %}
    <p class="empty">Chưa có thu nhập ghi nhận kỳ này.</p>
  {% endif %}

  <p class="section-title">Hũ chi tiêu (tháng {{ month }})</p>
  {% if budget_statuses %}
    {% for b in budget_statuses %}
    <div class="budget-item">
      <div class="budget-label">
        <span>{{ b.category_name }}</span>
        <span class="{{ 'warning' if b.over_budget else '' }}">{{ b.spent_display }} / {{ b.limit_display }}</span>
      </div>
      <div class="budget-bar-bg">
        <div class="budget-bar-fill {{ 'over' if b.over_budget else '' }}" style="width: {{ b.pct_used }}%;"></div>
      </div>
    </div>
    {% endfor %}
  {% else %}
    <p class="empty">Chưa đặt ngân sách cho danh mục nào (CLI menu 12) — hoặc dùng ngân sách theo kỳ mới ở trang <a href="/budgets">Ngân sách</a>.</p>
  {% endif %}

  <p class="section-title">Xu hướng tỉ lệ tiết kiệm (các kỳ đã qua)</p>
  {% if savings_trend.has_data %}
    {% for p in savings_trend.periods %}
    <div class="summary-row"><span>{{ p.period_id }}</span><span class="{{ 'good' if p.positive else 'warning' }}">{{ p.savings_display }} ({{ p.rate_display }})</span></div>
    {% endfor %}
    {% if savings_trend.trend_label %}<p class="note">{{ savings_trend.trend_label }}</p>{% endif %}
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần ít nhất 1 kỳ đã qua có giao dịch).</p>
  {% endif %}

  <p style="text-align:center; margin-top: 16px;"><a href="/forecast" style="color:#007aff; font-size:0.9rem;">Xem dự báo dòng tiền 6-12 kỳ tới →</a></p>
</div>
</body>
</html>
"""


IMPORT_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Nhập từ ảnh chụp</title>
<style>""" + BASE_STYLE + """
  input[type="file"] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
    background: #fff;
  }
  button#save {
    width: 100%;
    margin-top: 16px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
  #message.error { margin-top: 14px; padding: 12px; border-radius: 10px; background: #fdecea; color: #c0392b; }
  pre.raw-text { white-space: pre-wrap; font-size: 0.8rem; color: #555; background: #f4f5f7; padding: 10px; border-radius: 8px; margin-top: 12px; }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Trang chủ</a>
  <a href="/add">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng quan</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import" class="active">Nhập ảnh</a>
  <a href="/rules">Luật</a>
  <a href="/budgets">Ngân sách</a>
  <a href="/goals">Mục tiêu</a>
</div>
<div class="card">
  <h1>Nhập từ ảnh chụp</h1>
  <p class="tx-info">Chụp màn hình lịch sử giao dịch MoMo/MB Bank (có ghi chú rõ ràng), chọn ảnh ở đây — có thể chọn nhiều ảnh cùng lúc. Máy sẽ đọc số tiền và ghi chú, bạn xem lại và sửa trước khi lưu.</p>
  <form method="post" enctype="multipart/form-data">
    <input type="file" name="images" accept="image/*" multiple required>
    <button type="submit" id="save">Đọc ảnh</button>
  </form>
  {% if error %}<div id="message" class="error">{{ error }}</div>{% endif %}
  {% if raw_text %}<pre class="raw-text">{{ raw_text }}</pre>{% endif %}
</div>
</body>
</html>
"""


IMPORT_REVIEW_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="manifest" href="/static/manifest.json">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="icon" href="/static/favicon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sổ tài chính">
<meta name="theme-color" content="#007aff">
<title>Duyệt giao dịch từ ảnh</title>
<style>""" + BASE_STYLE + """
  .candidate {
    border: 1px solid #eee;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 14px;
  }
  .candidate label.field-label { margin: 10px 0 4px; }
  .candidate select, .candidate input[type="text"], .candidate input[type="date"] {
    width: 100%;
    padding: 10px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 8px;
  }
  .include-row { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .include-row input { width: auto; }
  pre.raw-text { white-space: pre-wrap; font-size: 0.8rem; color: #555; background: #f4f5f7; padding: 10px; border-radius: 8px; margin-bottom: 16px; }
  details summary { cursor: pointer; color: #007aff; font-size: 0.9rem; margin-bottom: 10px; }
  button#save {
    width: 100%;
    margin-top: 10px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Trang chủ</a>
  <a href="/add">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng quan</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import" class="active">Nhập ảnh</a>
  <a href="/rules">Luật</a>
  <a href="/budgets">Ngân sách</a>
  <a href="/goals">Mục tiêu</a>
</div>
<div class="card">
  <h1>{{ candidates|length }} giao dịch tìm thấy — kiểm tra trước khi lưu</h1>
  <details>
    <summary>Xem kết quả AI đọc được từ ảnh</summary>
    <pre class="raw-text">{{ raw_text }}</pre>
  </details>

  <form method="post" action="/import/confirm">
    {% for c in candidates %}
    <div class="candidate">
      <div class="include-row">
        <input type="checkbox" name="include" value="{{ loop.index0 }}" checked>
        <span>Lưu giao dịch này (ảnh #{{ c.image_index + 1 }})</span>
      </div>

      <label class="field-label">Ngày</label>
      <input type="date" name="date_{{ loop.index0 }}" value="{{ today }}">

      <label class="field-label">Loại</label>
      <select name="direction_{{ loop.index0 }}">
        <option value="out" {% if c.direction == 'out' %}selected{% endif %}>Chi tiền</option>
        <option value="in" {% if c.direction == 'in' %}selected{% endif %}>Thu tiền</option>
      </select>

      <label class="field-label">Tài khoản</label>
      <select name="account_{{ loop.index0 }}">
        {% for acc in accounts %}<option value="{{ acc.id }}">{{ acc.name }}</option>{% endfor %}
      </select>

      <input type="hidden" name="suggested_{{ loop.index0 }}" value="{{ c.suggested_category_id or '' }}">
      <label class="field-label">Danh mục</label>
      <select name="category_{{ loop.index0 }}">
        <option value="">-- Chưa phân loại --</option>
        {% for parent in categories %}
          {% if parent.children %}
            <optgroup label="{{ parent.name }}">
              {% for child in parent.children %}
                <option value="{{ child.id }}" {% if child.id == c.suggested_category_id %}selected{% endif %}>{{ child.name }}</option>
              {% endfor %}
            </optgroup>
          {% else %}
            <option value="{{ parent.id }}" {% if parent.id == c.suggested_category_id %}selected{% endif %}>{{ parent.name }}</option>
          {% endif %}
        {% endfor %}
      </select>

      <label class="field-label">Số tiền</label>
      <input type="text" inputmode="numeric" name="amount_{{ loop.index0 }}" value="{{ c.amount }}">

      <label class="field-label">Ghi chú</label>
      <input type="text" name="note_{{ loop.index0 }}" value="{{ c.note }}">
    </div>
    {% endfor %}

    <button type="submit" id="save">Lưu các giao dịch đã chọn</button>
  </form>
</div>
</body>
</html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
