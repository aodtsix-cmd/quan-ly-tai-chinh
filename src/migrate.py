"""Applies additive schema changes from src/migrations/*.sql, in filename order.

Unlike schema.sql (which is pure `CREATE TABLE IF NOT EXISTS` and can be safely
re-run forever), a real migration file may contain `ALTER TABLE ... ADD COLUMN`,
and SQLite has no `ADD COLUMN IF NOT EXISTS` — running the same ALTER twice
raises "duplicate column name". schema_migrations tracks which files have
already been applied so this script is itself safe to re-run.

Each migration file must be self-contained and additive only (no DROP, no data
loss) — the whole point of this mechanism is that data/finance.db never needs
to be recreated from scratch to pick up a schema change.
"""

import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DB_PATH = PROJECT_ROOT / "data" / "finance.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def run_migrations(db_path=None):
    """Returns the list of migration filenames that were newly applied."""
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
               filename   TEXT PRIMARY KEY,
               applied_at TEXT NOT NULL DEFAULT (datetime('now'))
           )"""
    )
    conn.commit()

    cursor = conn.execute("SELECT filename FROM schema_migrations")
    already_applied = {row[0] for row in cursor.fetchall()}

    applied_now = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in already_applied:
            continue
        conn.executescript(path.read_text(encoding="utf-8"))
        conn.execute("INSERT INTO schema_migrations (filename) VALUES (?)", (path.name,))
        conn.commit()
        applied_now.append(path.name)

    conn.close()
    return applied_now


if __name__ == "__main__":
    applied = run_migrations()
    if applied:
        print(f"Đã áp dụng {len(applied)} migration mới:")
        for name in applied:
            print(f"  - {name}")
    else:
        print("Không có migration mới nào cần áp dụng.")
