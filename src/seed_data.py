import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "data" / "finance.db"

# ============ ACCOUNTS ============
# (name, type, initial balance, is liquid asset)
ACCOUNTS = [
    ("MB Thanh toán", "bank", 0, 1),
    ("MB Thẻ tín dụng", "credit_card", 0, 0),  # credit card debt does not count as a liquid asset
    ("MoMo", "ewallet", 0, 1),
    ("Tiền mặt", "cash", 0, 1),
]

# ============ EXPENSE CATEGORIES (tree) ============
# Parent: (name_vi, name_en, kind, necessity, stability, [list of children])
# Child: (name_vi, name_en, necessity, stability) — inherits "kind" from parent
CATEGORY_TREE = [
    ("Nhà ở", "Housing", "expense", "essential", "fixed", [
        ("Tiền phòng/thuê nhà", "Rent", "essential", "fixed"),
        ("Điện nước", "Utilities", "essential", "fixed"),
        ("Internet/Wifi", "Internet", "essential", "fixed"),
        ("Phí quản lý", "Management fee", "essential", "fixed"),
    ]),
    ("Ăn uống", "Food", "expense", "essential", "variable", [
        ("Ăn ngoài", "Eating out", "essential", "variable"),
        ("Đi chợ/Nấu ăn", "Groceries", "essential", "variable"),
        ("Cà phê/Trà sữa", "Coffee/Tea", "optional", "variable"),
    ]),
    ("Di chuyển", "Transportation", "expense", "essential", "variable", [
        ("Xăng xe", "Fuel", "essential", "variable"),
        ("Grab/Taxi/Xe buýt", "Ride-hailing/Bus", "essential", "variable"),
        ("Gửi xe", "Parking", "essential", "variable"),
        ("Sửa xe", "Vehicle repair", "essential", "variable"),
    ]),
    ("Học tập", "Education", "expense", "essential", "variable", [
        ("Học phí", "Tuition", "essential", "fixed"),
        ("Sách/Tài liệu", "Books/Materials", "essential", "variable"),
        ("Khóa học thêm", "Extra courses", "optional", "variable"),
    ]),
    ("Sức khỏe", "Health", "expense", "essential", "variable", [
        ("Khám bệnh/Thuốc", "Medical/Medicine", "essential", "variable"),
        ("Bảo hiểm", "Insurance", "essential", "fixed"),
    ]),
    ("Bản thân & Giải trí", "Self & Entertainment", "expense", "optional", "variable", [
        ("Quần áo/Làm đẹp", "Clothing/Beauty", "optional", "variable"),
        ("Giải trí/Xem phim", "Entertainment", "optional", "variable"),
        ("Đăng ký dịch vụ", "Subscriptions", "optional", "fixed"),
        ("Du lịch", "Travel", "optional", "variable"),
    ]),
    ("Mối quan hệ", "Relationships", "expense", "optional", "variable", [
        ("Hẹn hò/Bạn bè", "Dating/Friends", "optional", "variable"),
        ("Quà tặng", "Gifts", "optional", "variable"),
        ("Hiếu hỉ", "Weddings/Funerals", "optional", "variable"),
    ]),
    ("Đóng góp & Từ thiện", "Charity", "expense", "optional", "variable", []),
    ("Gia đình", "Family", "expense", "essential", "variable", [
        ("Chuyển khoản cho gia đình", "Family transfer", "essential", "variable"),
        ("Quà cho gia đình", "Family gifts", "optional", "variable"),
    ]),
    ("Tài chính cá nhân", "Personal Finance", "expense", "essential", "fixed", [
        ("Trả nợ/Trả góp", "Debt repayment", "essential", "fixed"),
        ("Tiết kiệm/Đầu tư", "Savings/Investment", "essential", "fixed"),
    ]),
    ("Khác", "Other", "expense", "optional", "variable", []),
]

# ============ INCOME CATEGORIES ============
INCOME_CATEGORIES = [
    ("Thu nhập từ dạy học", "Teaching income", "variable"),
    ("Trợ cấp gia đình", "Family support", "variable"),
    ("Học bổng", "Scholarship", "variable"),
    ("Thu nhập khác", "Other income", "variable"),
]

# ============ INTERNAL TRANSFERS ============
TRANSFER_CATEGORIES = [
    ("Chuyển khoản nội bộ", "Internal transfer", "variable"),
]

# ============ EVENT TEMPLATES (name, [suggested line items — no prices]) ============
# THIET-KE.md 3.8: hệ thống chỉ gợi ý khoản mục, không đưa giá (giá phụ
# thuộc địa phương/hoàn cảnh). "Chuyển nhà" list is verbatim from the design
# doc; the other two are common, well-known checklists for their event type.
EVENT_TEMPLATES = [
    ("Chuyển nhà", [
        "Tiền cọc nhà mới",
        "Xe chuyển đồ",
        "Phí môi giới",
        "Lắp internet mới",
        "Đổi khóa",
        "Rèm cửa, đồ dùng thiếu",
        "Phí quản lý tháng đầu",
        "Điện nước trùng hai nơi",
    ]),
    ("Cưới hỏi", [
        "Đặt cọc nhà hàng/địa điểm",
        "Trang phục cô dâu chú rể",
        "Chụp ảnh cưới",
        "Thiệp mời và in ấn",
        "Trang trí",
        "Nhẫn cưới",
        "Quay phim",
        "Tiệc/đãi khách",
        "Xe hoa/đưa đón",
        "Quà cảm ơn khách mời",
    ]),
    ("Du lịch", [
        "Vé máy bay/tàu xe",
        "Khách sạn",
        "Bảo hiểm du lịch",
        "Visa (nếu có)",
        "Ăn uống",
        "Vé tham quan/hoạt động",
        "Di chuyển tại điểm đến",
        "Mua sắm/quà lưu niệm",
        "Chi phí phát sinh",
    ]),
]


def seed_data():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    cursor = conn.cursor()

    # Safety check: has data already been seeded? Avoid duplicating it.
    cursor.execute("SELECT COUNT(*) FROM categories")
    if cursor.fetchone()[0] > 0:
        print("Cơ sở dữ liệu đã có danh mục. Bỏ qua bước gieo tài khoản/danh mục.")
        _seed_event_templates(cursor)
        conn.commit()
        conn.close()
        return

    # --- Accounts ---
    for name, acc_type, balance, is_liquid in ACCOUNTS:
        cursor.execute(
            """INSERT INTO accounts (name, type, current_balance, is_liquid)
               VALUES (?, ?, ?, ?)""",
            (name, acc_type, balance, is_liquid),
        )
    print(f"Đã thêm {len(ACCOUNTS)} tài khoản.")

    # --- Expense categories (tree: parents first, then children) ---
    count = 0
    for name_vi, name_en, kind, necessity, stability, children in CATEGORY_TREE:
        cursor.execute(
            """INSERT INTO categories (name_vi, name_en, kind, necessity, stability, parent_id)
               VALUES (?, ?, ?, ?, ?, NULL)""",
            (name_vi, name_en, kind, necessity, stability),
        )
        parent_id = cursor.lastrowid
        count += 1

        for child_name_vi, child_name_en, child_necessity, child_stability in children:
            cursor.execute(
                """INSERT INTO categories (name_vi, name_en, kind, necessity, stability, parent_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (child_name_vi, child_name_en, kind, child_necessity, child_stability, parent_id),
            )
            count += 1

    # --- Income categories ---
    for name_vi, name_en, stability in INCOME_CATEGORIES:
        cursor.execute(
            """INSERT INTO categories (name_vi, name_en, kind, stability, parent_id)
               VALUES (?, ?, 'income', ?, NULL)""",
            (name_vi, name_en, stability),
        )
        count += 1

    # --- Internal transfers ---
    for name_vi, name_en, stability in TRANSFER_CATEGORIES:
        cursor.execute(
            """INSERT INTO categories (name_vi, name_en, kind, stability, parent_id)
               VALUES (?, ?, 'transfer', ?, NULL)""",
            (name_vi, name_en, stability),
        )
        count += 1

    print(f"Đã thêm {count} danh mục.")

    _seed_event_templates(cursor)

    conn.commit()
    conn.close()
    print("Gieo dữ liệu hoàn tất.")


def _seed_event_templates(cursor):
    """Seeds EVENT_TEMPLATES independently of accounts/categories, guarded
    by its own count check — so re-running seed_data() after categories
    already exist still picks up newly-added event templates instead of
    exiting early before reaching this."""
    cursor.execute("SELECT COUNT(*) FROM event_templates")
    if cursor.fetchone()[0] > 0:
        return

    for template_name, item_names in EVENT_TEMPLATES:
        cursor.execute("INSERT INTO event_templates (name) VALUES (?)", (template_name,))
        template_id = cursor.lastrowid
        for item_name in item_names:
            cursor.execute(
                "INSERT INTO event_items (template_id, name) VALUES (?, ?)",
                (template_id, item_name),
            )
    print(f"Đã thêm {len(EVENT_TEMPLATES)} mẫu kế hoạch sự kiện.")


if __name__ == "__main__":
    seed_data()
