import sqlite3
from pathlib import Path

# Đường dẫn: file này nằm trong src/, nên thư mục dự án là cấp cha
DU_AN_GOC = Path(__file__).parent.parent
DUONG_DAN_DB = DU_AN_GOC / "data" / "finance.db"
DUONG_DAN_SCHEMA = DU_AN_GOC / "src" / "schema.sql"


def khoi_tao_co_so_du_lieu():
    """Đọc file schema.sql và tạo các bảng trong file cơ sở dữ liệu."""
    noi_dung_schema = DUONG_DAN_SCHEMA.read_text(encoding="utf-8")

    ket_noi = sqlite3.connect(DUONG_DAN_DB)
    ket_noi.executescript(noi_dung_schema)
    ket_noi.commit()
    ket_noi.close()

    print(f"Đã tạo cơ sở dữ liệu tại: {DUONG_DAN_DB}")


if __name__ == "__main__":
    khoi_tao_co_so_du_lieu()