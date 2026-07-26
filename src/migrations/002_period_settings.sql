-- Cau hinh chu ky tai chinh (mac dinh 15 thang nay - 14 thang sau, cau hinh
-- lai duoc qua app_settings thay vi bien moi truong, vi nguoi dung can doi
-- duoc luc dang chay, khong can khoi dong lai server).

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('period_start_day', '15');
