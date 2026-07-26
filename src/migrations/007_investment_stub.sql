-- Cho Giai doan 7 (dau tu/vang/ngoai te) - CHUA xay dung logic gi, chi tao
-- bang de Moc 5's "tong tai san" co the cong don vao ma khong can sua schema
-- lan nua khi Giai doan 7 thuc su duoc lam. Khong co man hinh CLI/web nao
-- ghi vao bang nay - se luon la 0 dong cho toi khi Giai doan 7 bat dau.

CREATE TABLE IF NOT EXISTS investment_assets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    asset_type    TEXT NOT NULL CHECK (asset_type IN ('stock', 'fund', 'gold', 'crypto', 'fx', 'other')),
    quantity      REAL NOT NULL DEFAULT 0,
    unit_cost     INTEGER,
    current_value INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
