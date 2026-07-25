import sqlite3
from pathlib import Path

# Path: this file lives in src/, so the project root is the parent directory
PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "data" / "finance.db"
SCHEMA_PATH = PROJECT_ROOT / "src" / "schema.sql"


def init_database():
    """Read schema.sql and create the tables in the database file."""
    # data/ isn't tracked in git (only *.db inside it is gitignored, but the
    # directory itself has no tracked file to bring it along on a fresh
    # clone) — sqlite3.connect() doesn't create parent directories, so a
    # brand new checkout would fail here without this.
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    schema_content = SCHEMA_PATH.read_text(encoding="utf-8")

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(schema_content)
    conn.commit()
    conn.close()

    print(f"Đã tạo cơ sở dữ liệu tại: {DB_PATH}")


if __name__ == "__main__":
    init_database()
