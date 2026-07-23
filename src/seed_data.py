import sqlite3
from pathlib import Path

DU_AN_GOC = Path(__file__).parent.parent
DUONG_DAN_DB = DU_AN_GOC / "data" / "finance.db"

# ============ TÀI KHOẢN ============
# (tên, loại, số dư ban đầu, có phải tài sản lỏng không)
TAI_KHOAN = [
    ("MB Thanh toán", "bank", 0, 1),
    ("MB Thẻ tín dụng", "credit_card", 0, 0),  # nợ thẻ không tính là tài sản lỏng
    ("MoMo", "ewallet", 0, 1),
    ("Tiền mặt", "cash", 0, 1),
]

# ============ DANH MỤC CHI TIÊU (dạng cây) ============
# Mục cha: (name_vi, name_en, kind, necessity, stability, [danh sách con])
# Mục con: (name_vi, name_en, necessity, stability) — kế thừa "kind" từ cha
CAY_DANH_MUC = [
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

# ============ DANH MỤC THU NHẬP ============
DANH_MUC_THU_NHAP = [
    ("Thu nhập từ dạy học", "Teaching income", "variable"),
    ("Trợ cấp gia đình", "Family support", "variable"),
    ("Học bổng", "Scholarship", "variable"),
    ("Thu nhập khác", "Other income", "variable"),
]

# ============ CHUYỂN KHOẢN NỘI BỘ ============
DANH_MUC_CHUYEN_KHOAN = [
    ("Chuyển khoản nội bộ", "Internal transfer", "variable"),
]


def gieo_du_lieu():
    ket_noi = sqlite3.connect(DUONG_DAN_DB)
    ket_noi.execute("PRAGMA foreign_keys = ON;")
    con_tro = ket_noi.cursor()

    # An toàn: kiểm tra đã gieo dữ liệu chưa, tránh gieo trùng
    con_tro.execute("SELECT COUNT(*) FROM categories")
    if con_tro.fetchone()[0] > 0:
        print("Cơ sở dữ liệu đã có danh mục. Dừng lại để tránh trùng lặp.")
        print("Nếu muốn gieo lại từ đầu, xóa file data/finance.db rồi chạy lại init_db.py trước.")
        ket_noi.close()
        return

    # --- Tài khoản ---
    for ten, loai, so_du, la_long in TAI_KHOAN:
        con_tro.execute(
            """INSERT INTO accounts (name, type, current_balance, is_liquid)
               VALUES (?, ?, ?, ?)""",
            (ten, loai, so_du, la_long),
        )
    print(f"Đã thêm {len(TAI_KHOAN)} tài khoản.")

    # --- Danh mục chi tiêu (cây: cha trước, con sau) ---
    so_luong = 0
    for name_vi, name_en, kind, necessity, stability, con_cai in CAY_DANH_MUC:
        con_tro.execute(
            """INSERT INTO categories (name_vi, name_en, kind, necessity, stability, parent_id)
               VALUES (?, ?, ?, ?, ?, NULL)""",
            (name_vi, name_en, kind, necessity, stability),
        )
        id_cha = con_tro.lastrowid
        so_luong += 1

        for ten_con, ten_con_en, nec_con, stab_con in con_cai:
            con_tro.execute(
                """INSERT INTO categories (name_vi, name_en, kind, necessity, stability, parent_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (ten_con, ten_con_en, kind, nec_con, stab_con, id_cha),
            )
            so_luong += 1

    # --- Danh mục thu nhập ---
    for name_vi, name_en, stability in DANH_MUC_THU_NHAP:
        con_tro.execute(
            """INSERT INTO categories (name_vi, name_en, kind, stability, parent_id)
               VALUES (?, ?, 'income', ?, NULL)""",
            (name_vi, name_en, stability),
        )
        so_luong += 1

    # --- Chuyển khoản nội bộ ---
    for name_vi, name_en, stability in DANH_MUC_CHUYEN_KHOAN:
        con_tro.execute(
            """INSERT INTO categories (name_vi, name_en, kind, stability, parent_id)
               VALUES (?, ?, 'transfer', ?, NULL)""",
            (name_vi, name_en, stability),
        )
        so_luong += 1

    print(f"Đã thêm {so_luong} danh mục.")

    ket_noi.commit()
    ket_noi.close()
    print("Gieo dữ liệu hoàn tất.")


if __name__ == "__main__":
    gieo_du_lieu()