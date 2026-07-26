-- Mo phong quyet dinh chi tieu (Moc 3): mot khoan chi du tinh, so sanh
-- nhieu phuong an (tra thang / tra gop / hoan lai) canh nhau.

CREATE TABLE IF NOT EXISTS spending_simulations (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    note                        TEXT,
    item_amount                 INTEGER NOT NULL CHECK (item_amount > 0),
    maintenance_cost_per_period INTEGER NOT NULL DEFAULT 0,
    expected_lifetime_periods   INTEGER NOT NULL DEFAULT 0,
    liquidity_snapshot          INTEGER,
    baseline_balances           TEXT,
    triggered_by_transaction_id INTEGER,
    ai_recommendation           TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (triggered_by_transaction_id) REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS spending_simulation_scenarios (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    simulation_id            INTEGER NOT NULL,
    scenario_type            TEXT NOT NULL CHECK (scenario_type IN ('pay_now', 'installments', 'delay')),
    installment_periods      INTEGER NOT NULL DEFAULT 1,
    delay_periods            INTEGER NOT NULL DEFAULT 0,
    total_cost_of_ownership  INTEGER NOT NULL,
    projected_balances       TEXT NOT NULL,
    traffic_light            TEXT NOT NULL CHECK (traffic_light IN ('green', 'yellow', 'red')),
    FOREIGN KEY (simulation_id) REFERENCES spending_simulations(id)
);
