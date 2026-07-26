-- Muc tieu tai chinh (Moc 2): tich luy dai han, nhieu ky, co tien do.
-- Phan biet voi event_plans (mot su kien cu the, thuong gon 1-2 ky).
-- Tien do tinh truc tiep tu so du tai khoan gan voi muc tieu (khong luu
-- current_amount rieng, tranh lech du lieu voi so du that).

CREATE TABLE IF NOT EXISTS goals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    goal_type      TEXT NOT NULL DEFAULT 'custom'
                   CHECK (goal_type IN ('emergency_fund', 'savings', 'investment', 'medical', 'custom')),
    target_amount  INTEGER NOT NULL CHECK (target_amount > 0),
    deadline       TEXT NOT NULL,
    account_id     INTEGER NOT NULL,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- event_plans chua co cot ngay dien ra su kien (schema goc chi co
-- id/name/template_id/created_at) - can them de lam duoc lien ket voi goals.
ALTER TABLE event_plans ADD COLUMN event_date TEXT;
ALTER TABLE event_plans ADD COLUMN linked_goal_id INTEGER REFERENCES goals(id);
ALTER TABLE event_plans ADD COLUMN goal_prompt_dismissed INTEGER NOT NULL DEFAULT 0;
