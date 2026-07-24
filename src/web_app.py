import os
import sqlite3
from datetime import datetime, timedelta

from flask import Flask, jsonify, redirect, render_template_string, request, session, url_for

import alerts
import risk
from ocr_import import analyze_image, make_external_ref
from transaction import (
    add_rule,
    apply_matching_rule,
    connect_db,
    generate_due_recurring,
    get_active_accounts,
    get_categories,
    get_monthly_totals,
    get_recent_transactions,
    get_transaction_by_id,
    insert_transaction,
    log_behavior_event,
    resolve_category,
    update_transaction_category,
)

app = Flask(__name__)

APP_PASSWORD = os.environ.get("APP_PASSWORD")
if not APP_PASSWORD:
    raise RuntimeError(
        "Chưa đặt biến môi trường APP_PASSWORD. "
        "Chạy ví dụ: APP_PASSWORD=matma_cua_ban python3 src/web_app.py"
    )

app.secret_key = os.environ.get("SECRET_KEY", os.urandom(32))
app.permanent_session_lifetime = timedelta(days=30)


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
            return redirect(url_for("index"))
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
def index():
    conn = connect_db()
    cursor = conn.cursor()
    accounts = accounts_as_json(cursor)
    categories_by_kind = {
        "expense": category_tree_as_json(cursor, "expense"),
        "income": category_tree_as_json(cursor, "income"),
    }
    active_alerts = alerts.get_active_alerts(cursor)
    if active_alerts:
        alerts.log_shown_alerts(cursor, active_alerts)
        conn.commit()
    conn.close()
    return render_template_string(
        PAGE_TEMPLATE, accounts=accounts, categories_by_kind=categories_by_kind, alerts=active_alerts
    )


@app.route("/transactions")
def transactions_page():
    conn = connect_db()
    cursor = conn.cursor()
    rows = get_recent_transactions(cursor, limit=50)
    conn.close()

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

    return render_template_string(LIST_TEMPLATE, transactions=transactions)


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
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")
    conn = connect_db()
    cursor = conn.cursor()
    totals = get_monthly_totals(cursor, month)
    conn.close()

    return render_template_string(
        SUMMARY_TEMPLATE,
        month=month,
        income_display=f"{totals['income']:,} đ",
        expense_display=f"{totals['expense']:,} đ",
        diff_display=f"{totals['income'] - totals['expense']:,} đ",
    )


RUNWAY_LEVEL_LABELS = {
    "nguy_hiem": "Nguy hiểm",
    "mong_manh": "Mong manh",
    "on": "Ổn",
    "vung": "Vững",
}


@app.route("/risk")
def risk_page():
    conn = connect_db()
    cursor = conn.cursor()

    forecast = risk.short_term_forecast(cursor)
    liquidity = risk.liquidity_risk(cursor)
    runway = risk.runway_months(cursor)
    this_month = datetime.now().strftime("%Y-%m")
    budget = risk.budget_balance_50_30_20(cursor, this_month)

    conn.close()

    return render_template_string(
        RISK_TEMPLATE,
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
        budget={
            "has_income": budget["income"] > 0,
            "essential_display": f"{budget['essential']:,} đ",
            "optional_display": f"{budget['optional']:,} đ",
            "savings_display": f"{budget['savings']:,} đ",
            "essential_pct": f"{budget['essential_pct']:.0f}" if budget["essential_pct"] is not None else "",
            "optional_pct": f"{budget['optional_pct']:.0f}" if budget["optional_pct"] is not None else "",
            "savings_pct": f"{budget['savings_pct']:.0f}" if budget["savings_pct"] is not None else "",
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
            found = analyze_image(image_bytes, image.mimetype or "image/png", categories_by_kind)
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
        conn.close()
        return render_template_string(
            IMPORT_TEMPLATE,
            error=f"Không đọc được ảnh (kiểm tra GEMINI_API_KEY, hoặc thử lại): {exc}",
        )

    accounts = accounts_as_json(cursor)
    all_categories = category_tree_as_json(cursor, "expense") + category_tree_as_json(cursor, "income")
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

    for i in request.form.getlist("include"):
        try:
            amount = int(request.form.get(f"amount_{i}", "").replace(",", "").replace(".", ""))
            account_id = int(request.form.get(f"account_{i}"))
        except (TypeError, ValueError):
            continue

        direction = request.form.get(f"direction_{i}")
        if amount <= 0 or direction not in ("in", "out"):
            continue

        category_id_raw = request.form.get(f"category_{i}")
        category_id = int(category_id_raw) if category_id_raw else None
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
            conn.commit()
            saved += 1
        except sqlite3.IntegrityError:
            conn.rollback()
            skipped_duplicate += 1

    conn.close()
    return redirect(url_for("transactions_page"))


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

    try:
        amount = int(data.get("amount"))
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Số tiền không hợp lệ."), 400

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


LOGIN_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
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
    <input type="password" name="password" placeholder="Mã truy cập" autofocus required>
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
    gap: 8px;
  }
  .nav a {
    flex: 1;
    text-align: center;
    padding: 10px 0;
    border-radius: 10px;
    background: #fff;
    color: #1c1c1e;
    text-decoration: none;
    font-size: 0.9rem;
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


PAGE_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
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
  .alert-banner {
    max-width: 480px;
    margin: 0 auto 12px;
    padding: 12px 14px;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .alert-banner.danger { background: #fdecea; color: #c0392b; }
  .alert-banner.warning { background: #fff4e5; color: #b9770e; }
  .alert-banner + .alert-banner { margin-top: -4px; }
</style>
</head>
<body>
<div class="nav">
  <a href="/" class="active">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
</div>
{% for alert in alerts %}
<div class="alert-banner {{ alert.level }}">{{ alert.message }}</div>
{% endfor %}
<div class="card">
  <h1>Thêm giao dịch</h1>
  <form id="tx-form">
    <div class="segmented">
      <input type="radio" id="dir-out" name="direction" value="out" checked>
      <label for="dir-out">Chi tiền</label>
      <input type="radio" id="dir-in" name="direction" value="in">
      <label for="dir-in">Thu tiền</label>
    </div>

    <label class="field-label" for="account">Tài khoản</label>
    <select id="account" required></select>

    <label class="field-label" for="category">Danh mục</label>
    <select id="category"></select>

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
    accountSelect.innerHTML = "";
    for (const acc of accounts) {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `${acc.name} (${formatVND(acc.balance)} đ)`;
      accountSelect.appendChild(opt);
    }
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

  document.querySelectorAll('input[name="direction"]').forEach((el) => {
    el.addEventListener("change", () => renderCategories(currentKind()));
  });

  amountInput.addEventListener("input", () => {
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
    const amount = parseInt(amountInput.value.replace(/\\D/g, ""), 10);

    if (!amount || amount <= 0) {
      showMessage("Vui lòng nhập số tiền hợp lệ.", false);
      return;
    }

    saveBtn.disabled = true;
    try {
      const resp = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction: direction,
          account_id: accountSelect.value,
          category_id: categorySelect.value,
          amount: amount,
          description: descriptionInput.value,
        }),
      });
      const data = await resp.json();
      showMessage(data.message, data.ok);
      if (data.ok) {
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
  renderCategories(currentKind());
</script>
</body>
</html>
"""


LIST_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Danh sách giao dịch</title>
<style>""" + BASE_STYLE + """
  .tx-row { padding: 12px 0; border-bottom: 1px solid #eee; }
  .tx-row:last-child { border-bottom: none; }
  .tx-main { display: flex; justify-content: space-between; font-weight: 600; gap: 8px; }
  .tx-amount.in { color: #1e7a34; }
  .tx-amount.out { color: #c0392b; }
  .tx-sub { font-size: 0.85rem; color: #777; margin-top: 2px; display: flex; justify-content: space-between; gap: 8px; }
  .tx-edit { color: #007aff; text-decoration: none; white-space: nowrap; }
  .empty { text-align: center; color: #888; padding: 20px 0; }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Thêm</a>
  <a href="/transactions" class="active">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
</div>
<div class="card">
  <h1>{{ transactions|length }} giao dịch gần đây</h1>
  {% if transactions %}
    {% for tx in transactions %}
    <div class="tx-row">
      <div class="tx-main">
        <span>{{ tx.category_name }}</span>
        <span class="tx-amount {{ tx.sign_class }}">{{ tx.amount_display }}</span>
      </div>
      <div class="tx-sub">
        <span>{{ tx.occurred_at }} · {{ tx.account_name }}{% if tx.description %} · {{ tx.description }}{% endif %}</span>
        <a class="tx-edit" href="/transactions/{{ tx.id }}/edit">Sửa</a>
      </div>
    </div>
    {% endfor %}
  {% else %}
    <p class="empty">Chưa có giao dịch nào.</p>
  {% endif %}
</div>
</body>
</html>
"""


SUMMARY_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Tổng theo tháng</title>
<style>""" + BASE_STYLE + """
  input[type="month"] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
    margin-bottom: 18px;
  }
  .summary-row {
    display: flex;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid #eee;
    font-size: 1.05rem;
  }
  .summary-row.total { border-bottom: none; margin-top: 4px; font-size: 1.15rem; font-weight: 600; }
  .summary-row .in { color: #1e7a34; }
  .summary-row .out { color: #c0392b; }
</style>
</head>
<body>
<div class="nav">
  <a href="/">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary" class="active">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
</div>
<div class="card">
  <h1>Tổng theo tháng</h1>
  <form method="get">
    <input type="month" name="month" value="{{ month }}" onchange="this.form.submit()">
  </form>
  <div class="summary-row"><span>Thu</span><span class="in">{{ income_display }}</span></div>
  <div class="summary-row"><span>Chi</span><span class="out">{{ expense_display }}</span></div>
  <div class="summary-row total"><span>Chênh lệch</span><span>{{ diff_display }}</span></div>
</div>
</body>
</html>
"""


EDIT_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
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
  <a href="/">Thêm</a>
  <a href="/transactions" class="active">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
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
</style>
</head>
<body>
<div class="nav">
  <a href="/">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk" class="active">Sức khỏe TC</a>
  <a href="/import">Nhập ảnh</a>
</div>
<div class="card">
  <h1>Tình hình tài chính</h1>

  <p class="section-title">Dự báo ngắn hạn (còn lại tháng này)</p>
  <div class="summary-row"><span>Số dư khả dụng</span><span>{{ forecast.liquid_balance_display }}</span></div>
  <div class="summary-row"><span>Khoản định kỳ còn phải trả</span><span>{{ forecast.remaining_recurring_display }}</span></div>
  <div class="summary-row"><span>Chi tiêu dự kiến còn lại</span><span>{{ forecast.projected_spend_display }}</span></div>
  <div class="summary-row total {{ 'danger' if forecast.at_risk else 'good' }}">
    <span>Dự báo cuối tháng</span><span>{{ forecast.forecast_balance_display }}</span>
  </div>
  {% if forecast.at_risk %}<p class="note warning">⚠️ Có thể âm quỹ cuối tháng nếu chi tiêu như hiện tại.</p>{% endif %}

  <p class="section-title">Rủi ro thanh khoản</p>
  {% if liquidity.has_data %}
    <div class="summary-row"><span>Tài sản lỏng</span><span>{{ liquidity.liquid_balance_display }}</span></div>
    <div class="summary-row"><span>Chi phí thiết yếu 1 tháng (ước tính)</span><span>{{ liquidity.essential_monthly_display }}</span></div>
    <p class="note {{ 'good' if liquidity.sufficient else 'warning' }}">
      {{ 'Đủ trang trải 1 tháng chi phí bắt buộc.' if liquidity.sufficient else '⚠️ Không đủ trang trải 1 tháng chi phí bắt buộc.' }}
    </p>
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần lịch sử chi tiêu ít nhất 1 tháng đã qua).</p>
  {% endif %}

  <p class="section-title">Nền móng tài chính</p>
  {% if runway.has_data %}
    <p>Nếu mất thu nhập, tài sản lỏng đủ sống <strong>{{ runway.months_display }} tháng</strong> —
       <span class="badge badge-{{ runway.level }}">{{ runway.level_label }}</span></p>
  {% else %}
    <p class="empty">Chưa đủ dữ liệu (cần lịch sử chi tiêu ít nhất 1 tháng đã qua).</p>
  {% endif %}

  <p class="section-title">Cân đối 50/30/20 (tháng {{ month }})</p>
  {% if budget.has_income %}
    <div class="summary-row"><span>Thiết yếu (≤ 50%)</span><span>{{ budget.essential_display }} ({{ budget.essential_pct }}%)</span></div>
    <div class="summary-row"><span>Tùy chọn (≤ 30%)</span><span>{{ budget.optional_display }} ({{ budget.optional_pct }}%)</span></div>
    <div class="summary-row"><span>Còn lại (≥ 20%)</span><span>{{ budget.savings_display }} ({{ budget.savings_pct }}%)</span></div>
  {% else %}
    <p class="empty">Chưa có thu nhập ghi nhận tháng này.</p>
  {% endif %}
</div>
</body>
</html>
"""


IMPORT_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
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
  <a href="/">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import" class="active">Nhập ảnh</a>
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
<title>Duyệt giao dịch từ ảnh</title>
<style>""" + BASE_STYLE + """
  .candidate {
    border: 1px solid #eee;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 14px;
  }
  .candidate .raw-line { font-size: 0.8rem; color: #888; margin-bottom: 8px; }
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
  <a href="/">Thêm</a>
  <a href="/transactions">Danh sách</a>
  <a href="/summary">Tổng tháng</a>
  <a href="/risk">Sức khỏe TC</a>
  <a href="/import" class="active">Nhập ảnh</a>
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
      <div class="raw-line">Dòng gốc: "{{ c.raw_line }}"</div>

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
