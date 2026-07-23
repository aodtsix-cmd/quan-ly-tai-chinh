import sqlite3
from pathlib import Path
from datetime import datetime

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "data" / "finance.db"


def connect_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row  # allows fetching columns by name instead of index
    return conn


def display_accounts(cursor):
    print("\n-- Tài khoản --")
    cursor.execute("SELECT id, name, current_balance FROM accounts WHERE is_active = 1")
    for row in cursor.fetchall():
        print(f"  {row['id']}. {row['name']}  (số dư: {row['current_balance']:,} đ)")


def display_categories(cursor, kind):
    print(f"\n-- Danh mục ({kind}) --")
    cursor.execute(
        """SELECT id, name_vi, parent_id FROM categories
           WHERE kind = ? ORDER BY parent_id IS NOT NULL, parent_id, id""",
        (kind,),
    )
    for row in cursor.fetchall():
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

    occurred_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute(
        """INSERT INTO transactions
           (occurred_at, amount, direction, account_id, category_id,
            description, note, source, is_reviewed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1)""",
        (occurred_at, amount, direction, int(account_id), category_id, description, note),
    )

    # Update the account balance immediately
    balance_delta = amount if direction == "in" else -amount
    cursor.execute(
        "UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?",
        (balance_delta, int(account_id)),
    )

    conn.commit()
    conn.close()
    print(f"\n✔ Đã ghi nhận giao dịch: {amount:,} đ")


def list_transactions(limit=15):
    conn = connect_db()
    cursor = conn.cursor()

    print(f"\n===== {limit} GIAO DỊCH GẦN NHẤT =====")
    cursor.execute(
        """SELECT t.occurred_at, t.amount, t.direction, t.description,
                  a.name AS account_name, c.name_vi AS category_name
           FROM transactions t
           JOIN accounts a ON t.account_id = a.id
           LEFT JOIN categories c ON t.category_id = c.id
           ORDER BY t.occurred_at DESC
           LIMIT ?""",
        (limit,),
    )
    rows = cursor.fetchall()
    if not rows:
        print("Chưa có giao dịch nào.")
    for row in rows:
        sign = "+" if row["direction"] == "in" else "-"
        category_name = row["category_name"] or "(chưa phân loại)"
        print(f"{row['occurred_at']}  {sign}{row['amount']:,} đ  "
              f"[{category_name}]  {row['account_name']}  — {row['description']}")

    conn.close()


def monthly_summary():
    conn = connect_db()
    cursor = conn.cursor()

    month = input("Xem tháng nào? (định dạng YYYY-MM, vd 2026-07): ").strip()

    cursor.execute(
        """SELECT direction, SUM(amount) AS total
           FROM transactions
           WHERE strftime('%Y-%m', occurred_at) = ?
           GROUP BY direction""",
        (month,),
    )
    totals = {row["direction"]: row["total"] for row in cursor.fetchall()}
    income = totals.get("in", 0)
    expense = totals.get("out", 0)

    print(f"\n===== TỔNG THÁNG {month} =====")
    print(f"  Thu:      {income:,} đ")
    print(f"  Chi:      {expense:,} đ")
    print(f"  Chênh lệch: {income - expense:,} đ")

    conn.close()


def main_menu():
    while True:
        print("\n========== SỔ TÀI CHÍNH ==========")
        print("1. Thêm giao dịch")
        print("2. Xem danh sách gần đây")
        print("3. Tổng theo tháng")
        print("0. Thoát")
        choice = input("Chọn: ").strip()

        if choice == "1":
            add_transaction()
        elif choice == "2":
            list_transactions()
        elif choice == "3":
            monthly_summary()
        elif choice == "0":
            print("Tạm biệt!")
            break
        else:
            print("Lựa chọn không hợp lệ, thử lại.")


if __name__ == "__main__":
    main_menu()
