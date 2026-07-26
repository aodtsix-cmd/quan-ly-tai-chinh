-- Du bao dong tien (Moc 4): du bao 6-12 ky toi, kich ban goc va kich ban
-- co dieu chinh theo boi canh vi mo (tach rieng, song song, khong ghi de).

CREATE TABLE IF NOT EXISTS cashflow_forecasts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    periods_ahead         INTEGER NOT NULL,
    scenario              TEXT NOT NULL DEFAULT 'base' CHECK (scenario IN ('base', 'macro_adjusted')),
    base_forecast_id      INTEGER,
    seasonality_applied   INTEGER NOT NULL DEFAULT 0,
    seasonality_details   TEXT,
    macro_adjustment      INTEGER,
    macro_context_note    TEXT,
    macro_context_sources TEXT,
    FOREIGN KEY (base_forecast_id) REFERENCES cashflow_forecasts(id)
);

CREATE TABLE IF NOT EXISTS cashflow_forecast_periods (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    forecast_id       INTEGER NOT NULL,
    period_index      INTEGER NOT NULL,
    period_id         TEXT NOT NULL,
    projected_balance INTEGER NOT NULL,
    projected_income  INTEGER NOT NULL,
    projected_expense INTEGER NOT NULL,
    is_danger         INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (forecast_id) REFERENCES cashflow_forecasts(id)
);
