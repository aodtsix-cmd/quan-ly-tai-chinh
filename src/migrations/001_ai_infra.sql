-- Ha tang dung chung cho moi tinh nang AI (Moc 1-5): cache ket qua theo
-- (task, hash du lieu dau vao) de khong goi API moi lan tai trang, va log
-- moi lan goi API that de theo doi chi phi/do tin cay.

CREATE TABLE IF NOT EXISTS ai_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task        TEXT NOT NULL,
    input_hash  TEXT NOT NULL,
    response    TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    UNIQUE (task, input_hash)
);

CREATE TABLE IF NOT EXISTS ai_calls (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task             TEXT NOT NULL,
    model            TEXT NOT NULL,
    occurred_at      TEXT NOT NULL DEFAULT (datetime('now')),
    success          INTEGER NOT NULL,
    prompt_tokens    INTEGER,
    response_tokens  INTEGER,
    total_tokens     INTEGER,
    error_message    TEXT
);
