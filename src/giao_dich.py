import sqlite3
from pathlib import Path
from datetime import datetime

DU_AN_GOC = Path(__file__).parent.parent
DUONG_DAN_DB = DU_AN_GOC / "data" / "finance.db"


def ket_noi():
    kn = sqlite3.connect(DUONG_DAN_DB)
    kn.execute("PRAGMA foreign_keys = ON;")
    kn.row_factory = sqlite3.Row  # cho phép lấy dữ liệu theo tên cột thay vì chỉ số
    return kn


def hien_thi_tai_khoan(con_tro):
    print("\n-- Tài khoản --")
    con_tro.execute("SELECT id, name, current_balance FROM accounts WHERE is_active = 1")
    for hang in con_tro.fetchall():
        print(f"  {hang['id']}. {hang['name']}  (số dư: {hang['current_balance']:,} đ)")


def hien_thi_danh_muc(con_tro, kind):
    print(f"\n-- Danh mục ({kind}) --")
    con_tro.execute(
        """SELECT id, name_vi, parent_id FROM categories
           WHERE kind = ? ORDER BY parent_id IS NOT NULL, parent_id, id""",
        (kind,),
    )
    for hang in con_tro.fetchall():
        tien_to = "    " if hang["parent_id"] else "  "
        print(f"{tien_to}{hang['id']}. {hang['name_vi']}")


def them_giao_dich():
    kn = ket_noi()
    con_tro = kn.cursor()

    print("\n===== THÊM GIAO DỊCH =====")

    huong = input("Loại (1 = Chi tiền, 2 = Thu tiền): ").strip()
    if huong == "1":
        direction = "out"
        kind_danh_muc = "expense"
    elif huong == "2":
        direction = "in"
        kind_danh_muc = "income"
    else:
        print("Lựa chọn không hợp lệ.")
        kn.close()
        return

    hien_thi_tai_khoan(con_tro)
    account_id = input("Chọn mã tài khoản: ").strip()

    hien_thi_danh_muc(con_tro, kind_danh_muc)
    category_id = input("Chọn mã danh mục (bỏ trống nếu chưa rõ): ").strip()
    category_id = int(category_id) if category_id else None

    so_tien_raw = input("Số tiền (VNĐ, chỉ gõ số): ").strip().replace(",", "")
    try:
        so_tien = int(so_tien_raw)
    except ValueError:
        print("Số tiền không hợp lệ.")
        kn.close()
        return

    mo_ta = input("Mô tả (vd: Ăn trưa Highlands): ").strip()
    ghi_chu = input("Ghi chú thêm (Enter để bỏ qua): ").strip() or None

    thoi_gian = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    con_tro.execute(
        """INSERT INTO transactions
           (occurred_at, amount, direction, account_id, category_id,
            description, note, source, is_reviewed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1)""",
        (thoi_gian, so_tien, direction, int(account_id), category_id, mo_ta, ghi_chu),
    )

    # Cập nhật số dư tài khoản ngay
    thay_doi = so_tien if direction == "in" else -so_tien
    con_tro.execute(
        "UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?",
        (thay_doi, int(account_id)),
    )

    kn.commit()
    kn.close()
    print(f"\n✔ Đã ghi nhận giao dịch: {so_tien:,} đ")


def xem_danh_sach(so_luong=15):
    kn = ket_noi()
    con_tro = kn.cursor()

    print(f"\n===== {so_luong} GIAO DỊCH GẦN NHẤT =====")
    con_tro.execute(
        """SELECT t.occurred_at, t.amount, t.direction, t.description,
                  a.name AS ten_tai_khoan, c.name_vi AS ten_danh_muc
           FROM transactions t
           JOIN accounts a ON t.account_id = a.id
           LEFT JOIN categories c ON t.category_id = c.id
           ORDER BY t.occurred_at DESC
           LIMIT ?""",
        (so_luong,),
    )
    hang_list = con_tro.fetchall()
    if not hang_list:
        print("Chưa có giao dịch nào.")
    for h in hang_list:
        dau = "+" if h["direction"] == "in" else "-"
        danh_muc = h["ten_danh_muc"] or "(chưa phân loại)"
        print(f"{h['occurred_at']}  {dau}{h['amount']:,} đ  "
              f"[{danh_muc}]  {h['ten_tai_khoan']}  — {h['description']}")

    kn.close()


def tong_theo_thang():
    kn = ket_noi()
    con_tro = kn.cursor()

    thang = input("Xem tháng nào? (định dạng YYYY-MM, vd 2026-07): ").strip()

    con_tro.execute(
        """SELECT direction, SUM(amount) AS tong
           FROM transactions
           WHERE strftime('%Y-%m', occurred_at) = ?
           GROUP BY direction""",
        (thang,),
    )
    ket_qua = {h["direction"]: h["tong"] for h in con_tro.fetchall()}
    thu = ket_qua.get("in", 0)
    chi = ket_qua.get("out", 0)

    print(f"\n===== TỔNG THÁNG {thang} =====")
    print(f"  Thu:      {thu:,} đ")
    print(f"  Chi:      {chi:,} đ")
    print(f"  Chênh lệch: {thu - chi:,} đ")

    kn.close()


def menu_chinh():
    while True:
        print("\n========== SỔ TÀI CHÍNH ==========")
        print("1. Thêm giao dịch")
        print("2. Xem danh sách gần đây")
        print("3. Tổng theo tháng")
        print("0. Thoát")
        lua_chon = input("Chọn: ").strip()

        if lua_chon == "1":
            them_giao_dich()
        elif lua_chon == "2":
            xem_danh_sach()
        elif lua_chon == "3":
            tong_theo_thang()
        elif lua_chon == "0":
            print("Tạm biệt!")
            break
        else:
            print("Lựa chọn không hợp lệ, thử lại.")


if __name__ == "__main__":
    menu_chinh()