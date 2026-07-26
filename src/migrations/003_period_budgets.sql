-- Ngan sach theo danh muc, theo ky (khong phai thang duong lich) - Moc 1.
-- Thay the cho bang "budgets" cu (van giu nguyen, khong xoa, khong dung nua).

CREATE TABLE IF NOT EXISTS period_budgets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id  INTEGER NOT NULL,
    period_id    TEXT NOT NULL,
    amount       INTEGER NOT NULL CHECK (amount > 0),
    source       TEXT NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual', 'suggested_fixed', 'suggested_variable', 'ai_adjusted')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    UNIQUE (category_id, period_id)
);
