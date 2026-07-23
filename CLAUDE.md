# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A personal finance tracker ("Quản lý tài chính cá nhân") built as a Python + SQLite CLI. The project is in **Stage 1** of a 7-stage roadmap described in [docs/THIET-KE.md](docs/THIET-KE.md) (Vietnamese design doc — read it before making schema or product-behavior decisions, it is the authoritative spec). Stage 1 scope: database + manual entry + transaction list + monthly totals, running in a terminal. Later stages (not yet built) add rule-based auto-categorization, email/OCR ingestion, a web UI, and risk-analysis features.

`init_db.py`, `seed_data.py`, and `transaction.py` use only the Python standard library. `web_app.py` is the one exception and needs Flask — see `requirements.txt`.

## Commands

```bash
# One-time: install the one third-party dependency (Flask, for web_app.py)
pip3 install -r requirements.txt

# Create the database and tables from schema.sql (data/finance.db, gitignored)
python3 src/init_db.py

# Seed initial accounts and categories (safe to re-run: no-ops if categories already exist)
python3 src/seed_data.py

# Run the interactive terminal CLI (add transaction / list recent / monthly totals)
python3 src/transaction.py

# Run the web form instead (same feature as "add transaction" in the CLI, browser-based)
python3 src/web_app.py
# Serves on http://0.0.0.0:5000 — reachable from other devices (e.g. a phone) on the same LAN.
```

There is no test suite, linter, or build step configured yet.

To reset the database from scratch: delete `data/finance.db`, then re-run `init_db.py` followed by `seed_data.py`.

## Architecture

**Storage**: single SQLite file at `data/finance.db`, gitignored (per docs/THIET-KE.md, real financial data must never be committed). Every module resolves the project root as `Path(__file__).parent.parent` and connects with `PRAGMA foreign_keys = ON` and `row_factory = sqlite3.Row`.

**Schema** ([src/schema.sql](src/schema.sql)) — four tables so far, defined and explained in full in docs/THIET-KE.md Part 3:
- `accounts` — one row per money store (bank, ewallet, credit_card, cash, savings). `is_liquid` flags whether it counts toward liquidity/emergency-fund calculations (e.g. credit card debt is not liquid).
- `categories` — self-referencing tree via `parent_id`. `kind` is expense/income/transfer. `necessity` (essential/optional) and `stability` (fixed/variable) exist specifically to power future risk metrics (50/30/20 rule, "months of runway" if income stops) — don't drop these columns even though Stage 1 doesn't use them yet.
- `transactions` — the central table. `amount` is always positive; sign is carried separately in `direction` (in/out). `source` tracks provenance (manual/email/ocr/recurring) for later automated-ingestion stages. `is_reviewed` exists for a not-yet-built batch-review workflow. `external_ref` is a dedupe key for future automated imports.
- `behavior_events` — structure exists now but is intentionally not written to until Stage 2+ (a deliberate, already-decided design choice — see THIET-KE.md Part 5). Don't start populating it as part of Stage 1 work unless asked.

Tables described in the design doc but **not yet in schema.sql** (planned for later stages): `rules`, `recurring`, `income_sources`, `event_templates`, `event_items`, `event_plans`. When implementing a later stage, add these incrementally rather than scaffolding them all up front.

**Balance maintenance**: `transaction.py` updates `accounts.current_balance` manually inside the same transaction as the insert (see `add_transaction`) — there's no trigger. Any new code path that inserts into `transactions` must update the account balance the same way. `web_app.py`'s `POST /api/transactions` handler replicates this same insert-then-update-balance logic.

**Web form** ([src/web_app.py](src/web_app.py)): a Flask alternative to the CLI's "add transaction" flow, for entering transactions from a phone browser instead of the terminal. Single route `/` renders one page (HTML/CSS/JS inlined via `render_template_string` — no `templates/` folder), with accounts and the category tree embedded as JSON at render time. Submission goes through `POST /api/transactions` (JSON in/out) via `fetch()`, so the page never reloads. It imports `connect_db` from `transaction.py` rather than duplicating the connection setup. It does not touch `note`, `is_reviewed` batching, or any other CLI feature beyond adding a transaction — extend `transaction.py` first if a feature needs to exist in both places.

## Code conventions actually in use

- Function/variable/constant names and comments across `transaction.py`, `seed_data.py`, `init_db.py` are in **English**, per docs/THIET-KE.md Part 6. User-facing text passed to `print()`/`input()` stays in **Vietnamese** — that's the target audience's language, not a convention to migrate away from.
- Money is always stored as integer VND (no decimals).
- Timestamps are stored as `TEXT` via `datetime.now().strftime("%Y-%m-%d %H:%M:%S")` / SQLite `datetime('now')`.
