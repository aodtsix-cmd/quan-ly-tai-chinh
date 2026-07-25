-- Bật kiểm tra khóa ngoại (SQLite mặc định tắt, phải bật thủ công)
PRAGMA foreign_keys = ON;

-- Bảng tài khoản / nguồn tiền
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('bank', 'ewallet', 'credit_card', 'cash', 'savings')),
    currency        TEXT NOT NULL DEFAULT 'VND',
    current_balance INTEGER NOT NULL DEFAULT 0,
    is_liquid       INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1
);

-- Bảng danh mục
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name_vi     TEXT NOT NULL,
    name_en     TEXT NOT NULL,
    parent_id   INTEGER,
    kind        TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
    necessity   TEXT CHECK (necessity IN ('essential', 'optional')),
    stability   TEXT CHECK (stability IN ('fixed', 'variable')),
    FOREIGN KEY (parent_id) REFERENCES categories(id)
);

-- Bảng giao dịch — trung tâm của hệ thống
CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at  TEXT NOT NULL,
    amount       INTEGER NOT NULL CHECK (amount > 0),
    direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    account_id   INTEGER NOT NULL,
    category_id  INTEGER,
    description  TEXT,
    note         TEXT,
    source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('email', 'ocr', 'manual', 'recurring')),
    is_reviewed  INTEGER NOT NULL DEFAULT 0,
    external_ref TEXT UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id)  REFERENCES accounts(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- Bảng nhật ký hành vi — tạo cấu trúc trước, chưa ghi dữ liệu (theo quyết định đã chốt)
CREATE TABLE IF NOT EXISTS behavior_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type     TEXT NOT NULL,
    transaction_id INTEGER,
    payload        TEXT,
    occurred_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

-- Bảng luật phân loại tự động (Giai đoạn 2)
CREATE TABLE IF NOT EXISTS rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern      TEXT NOT NULL,
    category_id  INTEGER NOT NULL,
    priority     INTEGER NOT NULL DEFAULT 100,
    hit_count    INTEGER NOT NULL DEFAULT 0,
    created_from TEXT NOT NULL DEFAULT 'user' CHECK (created_from IN ('user', 'learned')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- Bảng khoản định kỳ (Giai đoạn 2)
CREATE TABLE IF NOT EXISTS recurring (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    amount        INTEGER NOT NULL CHECK (amount > 0),
    direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    category_id   INTEGER,
    account_id    INTEGER NOT NULL,
    frequency     TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
    day_of_period INTEGER NOT NULL,
    next_due      TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (account_id)  REFERENCES accounts(id)
);

-- Bảng nguồn thu nhập (Giai đoạn 6, THIET-KE.md 3.7)
CREATE TABLE IF NOT EXISTS income_sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('fixed', 'variable')),
    expected_amount INTEGER NOT NULL CHECK (expected_amount > 0),
    reliability     INTEGER NOT NULL CHECK (reliability BETWEEN 0 AND 100),
    is_active       INTEGER NOT NULL DEFAULT 1
);

-- Bảng ngân sách theo danh mục ("hũ chi tiêu", lấy cảm hứng từ Timo —
-- Envelope Budgeting, THIET-KE.md 7.3 ghi "chưa triển khai" lúc thiết kế gốc)
CREATE TABLE IF NOT EXISTS budgets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id   INTEGER NOT NULL,
    monthly_limit INTEGER NOT NULL CHECK (monthly_limit > 0),
    is_active     INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(id)
);
