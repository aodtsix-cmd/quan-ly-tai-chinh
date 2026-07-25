import calendar
import json
import sqlite3
from datetime import date, datetime
from pathlib import Path

import risk

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "data" / "finance.db"

FREQUENCY_MONTHS = {"monthly": 1, "quarterly": 3, "yearly": 12}


def connect_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row  # allows fetching columns by name instead of index
    return conn


# ---------- Core data layer (shared by the CLI below and web_app.py) ----------

def get_active_accounts(cursor):
    cursor.execute(
        "SELECT id, name, current_balance FROM accounts WHERE is_active = 1 ORDER BY id"
    )
    return cursor.fetchall()


def get_categories(cursor, kind):
    cursor.execute(
        """SELECT id, name_vi, parent_id FROM categories
           WHERE kind = ? ORDER BY parent_id IS NOT NULL, parent_id, id""",
        (kind,),
    )
    return cursor.fetchall()


def insert_transaction(cursor, *, occurred_at, amount, direction, account_id,
                        category_id, description, note=None, source="manual",
                        is_reviewed=1, external_ref=None):
    """Insert a transaction and update the account balance in the same call.
    Raises sqlite3.IntegrityError if external_ref collides with an existing
    row (the dedupe key for automated imports) — callers that batch-insert
    untrusted rows (e.g. OCR import) should catch it per-row."""
    cursor.execute(
        """INSERT INTO transactions
           (occurred_at, amount, direction, account_id, category_id,
            description, note, source, is_reviewed, external_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (occurred_at, amount, direction, account_id, category_id, description,
         note, source, is_reviewed, external_ref),
    )
    balance_delta = amount if direction == "in" else -amount
    cursor.execute(
        "UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?",
        (balance_delta, account_id),
    )


def get_recent_transactions(cursor, limit=15):
    cursor.execute(
        """SELECT t.id, t.occurred_at, t.amount, t.direction, t.description,
                  a.name AS account_name, c.name_vi AS category_name
           FROM transactions t
           JOIN accounts a ON t.account_id = a.id
           LEFT JOIN categories c ON t.category_id = c.id
           ORDER BY t.occurred_at DESC, t.id DESC
           LIMIT ?""",
        (limit,),
    )
    return cursor.fetchall()


def get_transaction_by_id(cursor, transaction_id):
    cursor.execute(
        """SELECT t.id, t.occurred_at, t.amount, t.direction, t.description, t.category_id,
                  a.name AS account_name
           FROM transactions t
           JOIN accounts a ON t.account_id = a.id
           WHERE t.id = ?""",
        (transaction_id,),
    )
    return cursor.fetchone()


def update_transaction_category(cursor, transaction_id, category_id):
    cursor.execute(
        "UPDATE transactions SET category_id = ? WHERE id = ?",
        (category_id, transaction_id),
    )


def log_behavior_event(cursor, event_type, transaction_id=None, payload=None):
    cursor.execute(
        """INSERT INTO behavior_events (event_type, transaction_id, payload)
           VALUES (?, ?, ?)""",
        (event_type, transaction_id, json.dumps(payload) if payload is not None else None),
    )


def get_monthly_totals(cursor, month):
    """Return {"income": ..., "expense": ...} for a 'YYYY-MM' month string."""
    cursor.execute(
        """SELECT direction, SUM(amount) AS total
           FROM transactions
           WHERE strftime('%Y-%m', occurred_at) = ?
           GROUP BY direction""",
        (month,),
    )
    totals = {row["direction"]: row["total"] for row in cursor.fetchall()}
    return {"income": totals.get("in", 0), "expense": totals.get("out", 0)}


# ---------- Rules (auto-categorization) ----------

def apply_matching_rule(cursor, description):
    """If `description` matches an existing rule's pattern, return its category_id
    (and bump the rule's hit_count). Rules are tried highest-priority first."""
    if not description:
        return None
    cursor.execute("SELECT id, pattern, category_id FROM rules ORDER BY priority DESC, id")
    description_lower = description.lower()
    for row in cursor.fetchall():
        if row["pattern"].lower() in description_lower:
            cursor.execute("UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?", (row["id"],))
            return row["category_id"]
    return None


def resolve_category(cursor, category_id, description):
    """Return category_id as-is if given, otherwise try to auto-assign via a rule."""
    if category_id is not None:
        return category_id
    return apply_matching_rule(cursor, description)


def get_rules(cursor):
    cursor.execute(
        """SELECT r.id, r.pattern, r.priority, r.hit_count, c.name_vi AS category_name
           FROM rules r JOIN categories c ON r.category_id = c.id
           ORDER BY r.priority DESC, r.id"""
    )
    return cursor.fetchall()


def add_rule(cursor, *, pattern, category_id, priority=100, created_from="user"):
    cursor.execute(
        """INSERT INTO rules (pattern, category_id, priority, created_from)
           VALUES (?, ?, ?, ?)""",
        (pattern, category_id, priority, created_from),
    )


# ---------- Recurring transactions ----------

def _add_months(d, months):
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def get_active_recurring(cursor):
    cursor.execute(
        """SELECT rec.id, rec.name, rec.amount, rec.direction, rec.frequency, rec.next_due,
                  a.name AS account_name
           FROM recurring rec JOIN accounts a ON rec.account_id = a.id
           WHERE rec.is_active = 1
           ORDER BY rec.next_due"""
    )
    return cursor.fetchall()


def add_recurring(cursor, *, name, amount, direction, account_id, category_id,
                   frequency, day_of_period, next_due):
    cursor.execute(
        """INSERT INTO recurring
           (name, amount, direction, category_id, account_id, frequency, day_of_period, next_due)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, amount, direction, category_id, account_id, frequency, day_of_period, next_due),
    )


def generate_due_recurring(cursor, as_of=None):
    """Create a transaction for every active recurring item whose next_due has
    arrived, then advance next_due. Returns how many were generated."""
    as_of_date = date.fromisoformat(as_of) if as_of else date.today()
    cursor.execute(
        "SELECT * FROM recurring WHERE is_active = 1 AND next_due <= ? ORDER BY next_due",
        (as_of_date.isoformat(),),
    )
    due_rows = cursor.fetchall()

    for row in due_rows:
        insert_transaction(
            cursor,
            occurred_at=f"{row['next_due']} 00:00:00",
            amount=row["amount"],
            direction=row["direction"],
            account_id=row["account_id"],
            category_id=row["category_id"],
            description=row["name"],
            source="recurring",
            is_reviewed=0,
        )
        new_next_due = _add_months(date.fromisoformat(row["next_due"]), FREQUENCY_MONTHS[row["frequency"]])
        cursor.execute(
            "UPDATE recurring SET next_due = ? WHERE id = ?",
            (new_next_due.isoformat(), row["id"]),
        )

    return len(due_rows)


# ---------- Income sources ----------

def get_income_sources(cursor):
    cursor.execute(
        """SELECT id, name, type, expected_amount, reliability
           FROM income_sources WHERE is_active = 1 ORDER BY id"""
    )
    return cursor.fetchall()


def add_income_source(cursor, *, name, type_, expected_amount, reliability):
    cursor.execute(
        """INSERT INTO income_sources (name, type, expected_amount, reliability)
           VALUES (?, ?, ?, ?)""",
        (name, type_, expected_amount, reliability),
    )


# ---------- Category budgets ("hũ chi tiêu") ----------

def get_budgets(cursor):
    cursor.execute(
        """SELECT b.id, b.category_id, b.monthly_limit, c.name_vi AS category_name
           FROM budgets b JOIN categories c ON b.category_id = c.id
           WHERE b.is_active = 1
           ORDER BY c.name_vi"""
    )
    return cursor.fetchall()


def set_budget(cursor, *, category_id, monthly_limit):
    """Insert a new budget for this category, or update the existing active
    one — one active budget per category, so setting it again replaces the
    limit rather than creating a confusing duplicate."""
    cursor.execute("SELECT id FROM budgets WHERE category_id = ? AND is_active = 1", (category_id,))
    existing = cursor.fetchone()
    if existing:
        cursor.execute("UPDATE budgets SET monthly_limit = ? WHERE id = ?", (monthly_limit, existing["id"]))
    else:
        cursor.execute(
            "INSERT INTO budgets (category_id, monthly_limit) VALUES (?, ?)",
            (category_id, monthly_limit),
        )


# ---------- Terminal CLI ----------

def display_accounts(cursor):
    print("\n-- Tài khoản --")
    for row in get_active_accounts(cursor):
        print(f"  {row['id']}. {row['name']}  (số dư: {row['current_balance']:,} đ)")


def display_categories(cursor, kind):
    print(f"\n-- Danh mục ({kind}) --")
    for row in get_categories(cursor, kind):
        prefix = "    " if row["parent_id"] else "  "
        print(f"{prefix}{row['id']}. {row['name_vi']}")


def add_transaction():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== THÊM GIAO DỊCH =====")

    direction_choice = input("Loại (1 = Chi tiền, 2 = Thu tiền): ").strip()
    if direction_choice == "1":
        direction = "out"
        category_kind = "expense"
    elif direction_choice == "2":
        direction = "in"
        category_kind = "income"
    else:
        print("Lựa chọn không hợp lệ.")
        conn.close()
        return

    display_accounts(cursor)
    account_id = input("Chọn mã tài khoản: ").strip()

    display_categories(cursor, category_kind)
    category_id = input("Chọn mã danh mục (bỏ trống nếu chưa rõ): ").strip()
    category_id = int(category_id) if category_id else None

    amount_raw = input("Số tiền (VNĐ, chỉ gõ số): ").strip().replace(",", "")
    try:
        amount = int(amount_raw)
    except ValueError:
        print("Số tiền không hợp lệ.")
        conn.close()
        return

    description = input("Mô tả (vd: Ăn trưa Highlands): ").strip()
    note = input("Ghi chú thêm (Enter để bỏ qua): ").strip() or None

    resolved_category_id = resolve_category(cursor, category_id, description)
    if resolved_category_id is not None and category_id is None:
        cursor.execute("SELECT name_vi FROM categories WHERE id = ?", (resolved_category_id,))
        print(f"  → Tự động xếp vào danh mục: {cursor.fetchone()['name_vi']}")

    occurred_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    insert_transaction(
        cursor,
        occurred_at=occurred_at,
        amount=amount,
        direction=direction,
        account_id=int(account_id),
        category_id=resolved_category_id,
        description=description,
        note=note,
    )

    conn.commit()
    conn.close()
    print(f"\n✔ Đã ghi nhận giao dịch: {amount:,} đ")


def list_transactions(limit=15):
    conn = connect_db()
    cursor = conn.cursor()

    print(f"\n===== {limit} GIAO DỊCH GẦN NHẤT =====")
    rows = get_recent_transactions(cursor, limit)
    if not rows:
        print("Chưa có giao dịch nào.")
    for row in rows:
        sign = "+" if row["direction"] == "in" else "-"
        category_name = row["category_name"] or "(chưa phân loại)"
        print(f"#{row['id']}  {row['occurred_at']}  {sign}{row['amount']:,} đ  "
              f"[{category_name}]  {row['account_name']}  — {row['description']}")

    conn.close()


def edit_transaction_category_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== SỬA DANH MỤC GIAO DỊCH =====")
    list_transactions(limit=15)
    transaction_id_raw = input("Chọn mã giao dịch cần sửa (số sau dấu #): ").strip()
    try:
        transaction_id = int(transaction_id_raw)
    except ValueError:
        print("Mã không hợp lệ.")
        conn.close()
        return

    tx = get_transaction_by_id(cursor, transaction_id)
    if tx is None:
        print("Không tìm thấy giao dịch.")
        conn.close()
        return

    kind = "expense" if tx["direction"] == "out" else "income"
    display_categories(cursor, kind)
    new_category_raw = input("Chọn mã danh mục mới (bỏ trống để bỏ phân loại): ").strip()
    new_category_id = int(new_category_raw) if new_category_raw else None

    old_category_id = tx["category_id"]
    update_transaction_category(cursor, transaction_id, new_category_id)
    log_behavior_event(
        cursor, "category_overridden", transaction_id=transaction_id,
        payload={"old_category_id": old_category_id, "new_category_id": new_category_id},
    )
    conn.commit()
    print("\n✔ Đã cập nhật danh mục.")

    if new_category_id is not None and tx["description"]:
        pattern_raw = input(
            f"Lần sau giao dịch có mô tả chứa từ khóa nào thì tự xếp vào danh mục này? "
            f"(Enter = dùng nguyên mô tả \"{tx['description']}\", hoặc gõ 'khong' để bỏ qua): "
        ).strip()
        if pattern_raw.lower() not in ("khong", "không", "no", "n"):
            pattern = pattern_raw or tx["description"]
            add_rule(cursor, pattern=pattern, category_id=new_category_id, created_from="learned")
            conn.commit()
            print(f"✔ Đã thêm luật: mô tả chứa \"{pattern}\" → tự động xếp vào danh mục này.")

    conn.close()


def monthly_summary():
    conn = connect_db()
    cursor = conn.cursor()

    month = input("Xem tháng nào? (định dạng YYYY-MM, vd 2026-07): ").strip()
    totals = get_monthly_totals(cursor, month)
    income = totals["income"]
    expense = totals["expense"]

    print(f"\n===== TỔNG THÁNG {month} =====")
    print(f"  Thu:      {income:,} đ")
    print(f"  Chi:      {expense:,} đ")
    print(f"  Chênh lệch: {income - expense:,} đ")

    conn.close()


RUNWAY_LEVEL_LABELS = {
    "nguy_hiem": "Nguy hiểm",
    "mong_manh": "Mong manh",
    "on": "Ổn",
    "vung": "Vững",
}


def show_risk_report():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== TÌNH HÌNH TÀI CHÍNH =====")

    forecast = risk.short_term_forecast(cursor)
    print("\n-- Dự báo ngắn hạn (còn lại tháng này) --")
    print(f"  Số dư khả dụng hiện tại:      {forecast['liquid_balance']:,} đ")
    print(f"  Khoản định kỳ còn phải trả:   {forecast['remaining_recurring']:,} đ")
    print(f"  Chi tiêu dự kiến còn lại:     {forecast['projected_variable_spend']:,} đ")
    warn = "  ⚠️ CÓ THỂ ÂM QUỸ" if forecast["at_risk"] else ""
    print(f"  → Dự báo số dư cuối tháng:    {forecast['forecast_balance']:,} đ{warn}")

    liquidity = risk.liquidity_risk(cursor)
    print("\n-- Rủi ro thanh khoản --")
    if liquidity["essential_monthly_expense"] is None:
        print("  Chưa đủ dữ liệu (cần ít nhất 1 tháng lịch sử chi tiêu đã qua).")
    else:
        status = "Đủ trang trải" if liquidity["sufficient"] else "⚠️ KHÔNG ĐỦ trang trải"
        print(f"  Tài sản lỏng:                 {liquidity['liquid_balance']:,} đ")
        print(f"  Chi phí thiết yếu 1 tháng:    {liquidity['essential_monthly_expense']:,.0f} đ")
        print(f"  → {status} 1 tháng chi phí bắt buộc")

    runway = risk.runway_months(cursor)
    print("\n-- Nền móng tài chính --")
    if runway["months"] is None:
        print("  Chưa đủ dữ liệu (cần ít nhất 1 tháng lịch sử chi tiêu đã qua).")
    else:
        level_text = RUNWAY_LEVEL_LABELS[runway["level"]]
        print(f"  Nếu mất thu nhập, sống được: {runway['months']:.1f} tháng ({level_text})")

    margin = risk.income_sustainability_margin(cursor)
    print("\n-- Thu nhập ổn định --")
    if not margin["has_data"]:
        print("  Chưa đủ dữ liệu (cần khai báo nguồn thu nhập và có lịch sử chi tiêu).")
    else:
        status = "Đủ trang trải" if margin["sufficient"] else "⚠️ KHÔNG ĐỦ trang trải"
        print(f"  Thu nhập ổn định (đã tính độ tin cậy): {margin['reliable_income']:,.0f} đ/tháng")
        print(f"  Chi phí thiết yếu 1 tháng:              {margin['essential_monthly_expense']:,.0f} đ")
        print(f"  → {status} chi phí thiết yếu bằng thu nhập ổn định (chênh lệch {margin['margin']:,.0f} đ)")

    this_month = datetime.now().strftime("%Y-%m")
    budget = risk.budget_balance_50_30_20(cursor, this_month)
    print(f"\n-- Cân đối 50/30/20 (tháng {this_month}) --")
    if budget["income"] <= 0:
        print("  Chưa có thu nhập ghi nhận tháng này, không tính được tỉ lệ.")
    else:
        print(f"  Thiết yếu: {budget['essential']:,} đ ({budget['essential_pct']:.0f}%, khuyến nghị ≤ 50%)")
        print(f"  Tùy chọn:  {budget['optional']:,} đ ({budget['optional_pct']:.0f}%, khuyến nghị ≤ 30%)")
        print(f"  Còn lại:   {budget['savings']:,} đ ({budget['savings_pct']:.0f}%, khuyến nghị ≥ 20%)")

    conn.close()


def add_rule_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== THÊM LUẬT PHÂN LOẠI =====")
    pattern = input("Chuỗi cần khớp trong mô tả (vd: Highlands): ").strip()
    if not pattern:
        print("Chuỗi khớp không được để trống.")
        conn.close()
        return

    kind_choice = input("Danh mục thuộc loại nào? (1 = Chi tiêu, 2 = Thu nhập): ").strip()
    kind = {"1": "expense", "2": "income"}.get(kind_choice)
    if kind is None:
        print("Lựa chọn không hợp lệ.")
        conn.close()
        return

    display_categories(cursor, kind)
    category_id_raw = input("Chọn mã danh mục sẽ tự động gán: ").strip()
    try:
        category_id = int(category_id_raw)
    except ValueError:
        print("Mã danh mục không hợp lệ.")
        conn.close()
        return

    priority_raw = input("Độ ưu tiên (số càng lớn càng ưu tiên, Enter = 100): ").strip()
    priority = int(priority_raw) if priority_raw else 100

    add_rule(cursor, pattern=pattern, category_id=category_id, priority=priority)
    conn.commit()
    conn.close()
    print(f"\n✔ Đã thêm luật: mô tả chứa \"{pattern}\" → tự động xếp vào danh mục đã chọn.")


def list_rules_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== LUẬT PHÂN LOẠI =====")
    rows = get_rules(cursor)
    if not rows:
        print("Chưa có luật nào.")
    for row in rows:
        print(f"  [{row['id']}] \"{row['pattern']}\" → {row['category_name']} "
              f"(ưu tiên {row['priority']}, đã dùng {row['hit_count']} lần)")

    conn.close()


def add_recurring_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== THÊM KHOẢN ĐỊNH KỲ =====")
    name = input("Tên (vd: Tiền nhà, Netflix): ").strip()
    if not name:
        print("Tên không được để trống.")
        conn.close()
        return

    direction_choice = input("Loại (1 = Chi tiền, 2 = Thu tiền): ").strip()
    if direction_choice == "1":
        direction, kind = "out", "expense"
    elif direction_choice == "2":
        direction, kind = "in", "income"
    else:
        print("Lựa chọn không hợp lệ.")
        conn.close()
        return

    amount_raw = input("Số tiền mỗi kỳ (VNĐ, chỉ gõ số): ").strip().replace(",", "")
    try:
        amount = int(amount_raw)
    except ValueError:
        print("Số tiền không hợp lệ.")
        conn.close()
        return

    display_accounts(cursor)
    account_id_raw = input("Chọn mã tài khoản: ").strip()
    try:
        account_id = int(account_id_raw)
    except ValueError:
        print("Mã tài khoản không hợp lệ.")
        conn.close()
        return

    display_categories(cursor, kind)
    category_id_raw = input("Chọn mã danh mục (bỏ trống nếu chưa rõ): ").strip()
    category_id = int(category_id_raw) if category_id_raw else None

    frequency_choice = input("Chu kỳ (1 = Hàng tháng, 2 = Hàng quý, 3 = Hàng năm): ").strip()
    frequency = {"1": "monthly", "2": "quarterly", "3": "yearly"}.get(frequency_choice)
    if frequency is None:
        print("Lựa chọn không hợp lệ.")
        conn.close()
        return

    day_raw = input("Ngày trong kỳ (vd: 5 = ngày 5 mỗi tháng): ").strip()
    try:
        day_of_period = int(day_raw)
    except ValueError:
        print("Ngày không hợp lệ.")
        conn.close()
        return

    next_due_raw = input("Kỳ tiếp theo đến hạn khi nào? (YYYY-MM-DD): ").strip()
    try:
        next_due = date.fromisoformat(next_due_raw).isoformat()
    except ValueError:
        print("Ngày không hợp lệ.")
        conn.close()
        return

    add_recurring(
        cursor,
        name=name,
        amount=amount,
        direction=direction,
        account_id=account_id,
        category_id=category_id,
        frequency=frequency,
        day_of_period=day_of_period,
        next_due=next_due,
    )
    conn.commit()
    conn.close()
    print(f"\n✔ Đã thêm khoản định kỳ \"{name}\", đến hạn lần đầu: {next_due}")


def list_recurring_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== KHOẢN ĐỊNH KỲ =====")
    rows = get_active_recurring(cursor)
    if not rows:
        print("Chưa có khoản định kỳ nào.")
    for row in rows:
        sign = "+" if row["direction"] == "in" else "-"
        print(f"  [{row['id']}] {row['name']}: {sign}{row['amount']:,} đ "
              f"({row['frequency']}, kỳ tới: {row['next_due']}, {row['account_name']})")

    conn.close()


def add_income_source_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== THÊM NGUỒN THU NHẬP =====")
    name = input("Tên nguồn thu (vd: Lương dạy học, Học bổng): ").strip()
    if not name:
        print("Tên không được để trống.")
        conn.close()
        return

    type_choice = input("Loại (1 = Cố định, 2 = Bấp bênh): ").strip()
    type_ = {"1": "fixed", "2": "variable"}.get(type_choice)
    if type_ is None:
        print("Lựa chọn không hợp lệ.")
        conn.close()
        return

    amount_raw = input("Số tiền kỳ vọng mỗi tháng (VNĐ, chỉ gõ số): ").strip().replace(",", "")
    try:
        expected_amount = int(amount_raw)
    except ValueError:
        print("Số tiền không hợp lệ.")
        conn.close()
        return

    default_reliability = 100 if type_ == "fixed" else 50
    reliability_raw = input(f"Độ tin cậy (0-100%, Enter = {default_reliability}): ").strip()
    reliability = int(reliability_raw) if reliability_raw else default_reliability
    if not (0 <= reliability <= 100):
        print("Độ tin cậy phải trong khoảng 0-100.")
        conn.close()
        return

    add_income_source(cursor, name=name, type_=type_, expected_amount=expected_amount, reliability=reliability)
    conn.commit()
    conn.close()
    print(f"\n✔ Đã thêm nguồn thu nhập \"{name}\".")


def list_income_sources_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== NGUỒN THU NHẬP =====")
    rows = get_income_sources(cursor)
    if not rows:
        print("Chưa có nguồn thu nhập nào.")
    for row in rows:
        type_label = "Cố định" if row["type"] == "fixed" else "Bấp bênh"
        print(f"  [{row['id']}] {row['name']}: {row['expected_amount']:,} đ/tháng "
              f"({type_label}, tin cậy {row['reliability']}%)")

    conn.close()


def set_budget_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    print("\n===== ĐẶT NGÂN SÁCH THEO DANH MỤC (HŨ CHI TIÊU) =====")
    display_categories(cursor, "expense")
    category_id_raw = input("Chọn mã danh mục: ").strip()
    try:
        category_id = int(category_id_raw)
    except ValueError:
        print("Mã danh mục không hợp lệ.")
        conn.close()
        return

    limit_raw = input("Hạn mức chi mỗi tháng (VNĐ, chỉ gõ số): ").strip().replace(",", "")
    try:
        monthly_limit = int(limit_raw)
    except ValueError:
        print("Số tiền không hợp lệ.")
        conn.close()
        return

    set_budget(cursor, category_id=category_id, monthly_limit=monthly_limit)
    conn.commit()
    conn.close()
    print(f"\n✔ Đã đặt ngân sách {monthly_limit:,} đ/tháng cho danh mục đã chọn.")


def show_budget_status_interactive():
    conn = connect_db()
    cursor = conn.cursor()

    this_month = datetime.now().strftime("%Y-%m")
    print(f"\n===== NGÂN SÁCH THÁNG {this_month} =====")
    statuses = risk.get_budget_status(cursor, this_month)
    if not statuses:
        print("Chưa đặt ngân sách cho danh mục nào.")
    for s in statuses:
        marker = "  ⚠️ VƯỢT NGÂN SÁCH" if s["over_budget"] else ""
        print(f"  {s['category_name']}: {s['spent']:,} / {s['monthly_limit']:,} đ "
              f"({s['pct_used']:.0f}%){marker}")

    conn.close()


def main_menu():
    import alerts  # local import: alerts.py imports log_behavior_event from this module

    conn = connect_db()
    cursor = conn.cursor()
    generated = generate_due_recurring(cursor)
    active_alerts = alerts.get_active_alerts(cursor)
    if active_alerts:
        alerts.log_shown_alerts(cursor, active_alerts)
    conn.commit()
    conn.close()
    if generated:
        print(f"\n(Đã tự động sinh {generated} giao dịch định kỳ đến hạn.)")
    for alert in active_alerts:
        print(f"\n{alert['message']}")

    while True:
        print("\n========== SỔ TÀI CHÍNH ==========")
        print("1. Thêm giao dịch")
        print("2. Xem danh sách gần đây")
        print("3. Tổng theo tháng")
        print("4. Thêm luật phân loại")
        print("5. Xem luật phân loại")
        print("6. Thêm khoản định kỳ")
        print("7. Xem khoản định kỳ")
        print("8. Sửa danh mục giao dịch")
        print("9. Xem tình hình tài chính")
        print("10. Thêm nguồn thu nhập")
        print("11. Xem nguồn thu nhập")
        print("12. Đặt ngân sách theo danh mục (hũ chi tiêu)")
        print("13. Xem ngân sách tháng này")
        print("0. Thoát")
        choice = input("Chọn: ").strip()

        if choice == "1":
            add_transaction()
        elif choice == "2":
            list_transactions()
        elif choice == "3":
            monthly_summary()
        elif choice == "4":
            add_rule_interactive()
        elif choice == "5":
            list_rules_interactive()
        elif choice == "6":
            add_recurring_interactive()
        elif choice == "7":
            list_recurring_interactive()
        elif choice == "8":
            edit_transaction_category_interactive()
        elif choice == "9":
            show_risk_report()
        elif choice == "10":
            add_income_source_interactive()
        elif choice == "11":
            list_income_sources_interactive()
        elif choice == "12":
            set_budget_interactive()
        elif choice == "13":
            show_budget_status_interactive()
        elif choice == "0":
            print("Tạm biệt!")
            break
        else:
            print("Lựa chọn không hợp lệ, thử lại.")


if __name__ == "__main__":
    main_menu()
