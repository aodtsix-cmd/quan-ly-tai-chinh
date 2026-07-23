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
# APP_PASSWORD is required — the app raises RuntimeError at import time if it's unset.
APP_PASSWORD=your_shared_password python3 src/web_app.py
# Serves on http://0.0.0.0:8000 — reachable from other devices (e.g. a phone) on the same LAN.
# Port 8000, not 5000: macOS AirPlay Receiver squats on 5000 by default.
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

**Balance maintenance**: all writes go through `insert_transaction()` in `transaction.py`, which inserts the row and adjusts `accounts.current_balance` in the same call — there's no trigger. Any new code path that inserts into `transactions` must call this function rather than writing its own INSERT.

**Shared core vs. CLI vs. web** ([src/transaction.py](src/transaction.py)): the file has two halves. The top half (`get_active_accounts`, `get_categories`, `insert_transaction`, `get_recent_transactions`, `get_monthly_totals`) is pure data-layer — no `input()`/`print()` — and is imported by both the terminal CLI further down in the same file and by `web_app.py`. The bottom half (`display_accounts`, `add_transaction`, `list_transactions`, `monthly_summary`, `main_menu`) is the terminal UI, built on top of that data layer. **When changing how a transaction is read or written, change the shared function once** — don't patch `web_app.py`'s SQL and `transaction.py`'s SQL separately, they're meant to stay identical by construction, not by manual sync.

**Web form** ([src/web_app.py](src/web_app.py)): a Flask alternative to the CLI, for using the tracker from a phone browser instead of the terminal. Three routes mirror the CLI's three menu options: `/` (add transaction — the only one that's a JS single-page form posting to `POST /api/transactions` via `fetch()`, so it never reloads), `/transactions` (recent list), `/summary` (monthly totals, month picked via a native `<input type="month">` that auto-submits on change). All three pages share one inline CSS block (`BASE_STYLE`, plain string — deliberately not an f-string, so CSS `{ }` don't need escaping) and a nav bar linking between them. HTML/CSS/JS is inlined via `render_template_string` — no `templates/` folder.

**Auth on the web form**: single shared password, not per-user login (deliberate — see memory `project_web_form_multiuser_phase`: the goal right now is letting many people log transactions with minimal friction, not tracking who entered what). `APP_PASSWORD` is read from the environment and never hardcoded — the app refuses to start without it. A Flask session cookie (`session["authenticated"]`), valid 30 days, gates every route via a `before_request` hook except `/login`; `/api/*` returns 401 JSON instead of a redirect when unauthenticated. `SECRET_KEY` may also be set via env; if omitted it's a random value generated per-process, meaning all sessions invalidate on every restart — acceptable for this use case, don't "fix" it without being asked.

## Code conventions actually in use

- Function/variable/constant names and comments across `transaction.py`, `seed_data.py`, `init_db.py` are in **English**, per docs/THIET-KE.md Part 6. User-facing text passed to `print()`/`input()` stays in **Vietnamese** — that's the target audience's language, not a convention to migrate away from.
- Money is always stored as integer VND (no decimals).
- Timestamps are stored as `TEXT` via `datetime.now().strftime("%Y-%m-%d %H:%M:%S")` / SQLite `datetime('now')`.
