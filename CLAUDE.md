# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A personal finance tracker ("Quản lý tài chính cá nhân") built as Python + SQLite, usable from either a terminal CLI or a Flask web form. The project follows the 7-stage roadmap in [docs/THIET-KE.md](docs/THIET-KE.md) (Vietnamese design doc — read it before making schema or product-behavior decisions, it is the authoritative spec). **Stage 1** (manual entry, list, monthly totals) and **Stage 2** (auto-categorization, recurring transactions, learn-a-rule-from-correction) are fully built. The core risk metrics from **Stage 6** (Part 4 of the design doc — short-term cash-out forecast, liquidity risk, runway months, 50/30/20 budget balance) are also built, ahead of the roadmap order, in [src/risk.py](src/risk.py) — these were picked next over Stage 3 specifically because they need no external data/credentials and can't silently misparse real money the way a guessed email-parsing regex could. Not yet built: email/OCR ingestion (Stage 3–4, deliberately skipped so far — needs a real sample of MB Bank's email format before writing a parser, not a guessed one), a nicer web UI (current one is deliberately plain), event-planning features (rest of Stage 6) and Stage 7 (investments/gold/FX).

`init_db.py`, `seed_data.py`, `transaction.py`, and `risk.py` use only the Python standard library. `web_app.py` is the one exception and needs Flask — see `requirements.txt`.

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

To reset the database from scratch: delete `data/finance.db`, then re-run `init_db.py` followed by `seed_data.py`. **After pulling a change to `schema.sql`, re-run `python3 src/init_db.py` against your existing `data/finance.db`** — every statement in it is `CREATE TABLE IF NOT EXISTS`, so this only adds newly-introduced tables and never touches or drops existing data.

## Architecture

**Storage**: single SQLite file at `data/finance.db`, gitignored (per docs/THIET-KE.md, real financial data must never be committed). Every module resolves the project root as `Path(__file__).parent.parent` and connects with `PRAGMA foreign_keys = ON` and `row_factory = sqlite3.Row`.

**Schema** ([src/schema.sql](src/schema.sql)), defined and explained in full in docs/THIET-KE.md Part 3:
- `accounts` — one row per money store (bank, ewallet, credit_card, cash, savings). `is_liquid` flags whether it counts toward liquidity/emergency-fund calculations (e.g. credit card debt is not liquid).
- `categories` — self-referencing tree via `parent_id`. `kind` is expense/income/transfer. `necessity` (essential/optional) powers the risk metrics in `risk.py` (50/30/20 rule, "months of runway" if income stops — see below). `stability` (fixed/variable) is still unread by any code — don't drop it anyway, it's designed-in for later.
- `transactions` — the central table. `amount` is always positive; sign is carried separately in `direction` (in/out). `source` distinguishes manual/recurring entries now, and will carry email/ocr once those stages exist. `is_reviewed` exists for a not-yet-built batch-review workflow (recurring-generated transactions are inserted with `is_reviewed = 0`, matching the design doc's intent — manual entries are `1`). `external_ref` is a dedupe key for future automated imports.
- `behavior_events` — structure existed unwritten-to since Stage 1 by deliberate design (see THIET-KE.md Part 5: "tạo cấu trúc từ Giai đoạn 1, chỉ ghi dữ liệu thật từ Giai đoạn 2"). Now that Stage 2 work has started, `category_overridden` is the first event type actually being logged (see `log_behavior_event`, used when a transaction's category is edited). Other event types (`transaction_reviewed`, `alert_shown`, etc.) still have no writer — don't add one before the feature that produces that event actually exists.
- `rules` — auto-categorization: `pattern` is matched case-insensitively as a substring of a transaction's `description`; on match, `category_id` is assigned and `hit_count` increments. Tried highest-`priority` first. `created_from` distinguishes rules added directly (`'user'`, via CLI menu option 4) from ones learned by correcting a transaction's category (`'learned'`, via CLI menu option 8 or the web's edit-transaction page).
- `recurring` — recurring transaction templates (rent, subscriptions, ...). `next_due` advances by `frequency` (monthly/quarterly/yearly) each time it fires; `day_of_period` is stored but not currently used to compute due dates (next_due is set explicitly and advanced from itself, not recalculated from day_of_period — don't assume it's authoritative). Added via CLI menu option 6 only.

Tables described in the design doc but **not yet in schema.sql** (planned for later stages): `income_sources`, `event_templates`, `event_items`, `event_plans`. When implementing a later stage, add these incrementally rather than scaffolding them all up front.

**Auto-categorization and recurring generation** (both in [src/transaction.py](src/transaction.py), used by CLI and web alike):
- `resolve_category(cursor, category_id, description)` — if `category_id` is already given, returns it unchanged; otherwise tries `apply_matching_rule()` against `description`. Called by both `add_transaction()` (CLI) and `POST /api/transactions` (web) whenever the user leaves the category blank — never bypass this by inserting a transaction with a hardcoded category when the user didn't pick one.
- `generate_due_recurring(cursor, as_of=None)` — creates a transaction (via `insert_transaction`, so balances update too) for every active `recurring` row whose `next_due` has arrived, then advances `next_due`. It's idempotent within the same day (nothing left due ⇒ no-op), so it's safe to call on every request. It runs automatically: once at CLI startup (`main_menu`), and on every authenticated request in the web app (`before_request`, after the login check). Don't call it a second time within the same request/command — it's already covered at those two entry points.
- Editing a transaction's category (CLI menu 8 / web `/transactions/<id>/edit`) is the "learn from correction" loop from THIET-KE.md Part 3.5: after `update_transaction_category()`, it logs a `category_overridden` behavior event, then offers to create a `rules` row (`created_from="learned"`) from that transaction's `description` — the user can accept the full description as the pattern or type a shorter keyword instead. Only offered when a real category (not "uncategorized") was picked, since `rules.category_id` is `NOT NULL`.

**Risk metrics** ([src/risk.py](src/risk.py), a separate module from `transaction.py` — analytics is a distinct concern from transaction CRUD): implements THIET-KE.md Part 4 exactly, all four read-only, no writes:
- `short_term_forecast()` (4.1): projected available balance at month-end = liquid balance − recurring still due this month (`get_remaining_recurring_this_month`, only counts `next_due` strictly after today, since anything due today-or-earlier is assumed already turned into a real transaction by `generate_due_recurring`) − projected variable spend (`get_average_daily_variable_spend`, averaged over the trailing 30 days, **excluding `source = 'recurring'` rows** so recurring commitments aren't counted twice) × days left in the month.
- `liquidity_risk()` (4.2) and `runway_months()` (4.3) both build on `get_average_monthly_essential_expense()` — the average essential (`categories.necessity = 'essential'`) spend per calendar month over the last 3 *completed* months (current partial month excluded so it can't skew the average low). Returns `None`/`has_data=False` until there's at least one completed month of essential spending — never silently show a runway/liquidity number computed from zero history.
- `budget_balance_50_30_20(cursor, month)` (4.4): essential/optional spend vs. income for one `'YYYY-MM'` month, grouped via `categories.necessity`.
- All four accept an `as_of` override (defaults to `date.today()`) specifically so they're deterministic to test.
- Exposed via CLI menu option 9 (`show_risk_report`) and the web's `/risk` page — both call the exact same `risk.py` functions and just format the same numbers differently; don't duplicate the math in either UI layer.

**Balance maintenance**: all writes go through `insert_transaction()` in `transaction.py`, which inserts the row and adjusts `accounts.current_balance` in the same call — there's no trigger. Any new code path that inserts into `transactions` must call this function rather than writing its own INSERT.

**Shared core vs. CLI vs. web** ([src/transaction.py](src/transaction.py)): the file has two halves, marked by `# ----` section comments. The data-layer half (`get_active_accounts`, `get_categories`, `insert_transaction`, `get_recent_transactions`, `get_transaction_by_id`, `update_transaction_category`, `log_behavior_event`, `get_monthly_totals`, plus the rules/recurring functions listed above) has no `input()`/`print()` and is imported by both the terminal CLI further down in the same file and by `web_app.py`. The CLI half (`display_accounts`, `add_transaction`, `list_transactions`, `edit_transaction_category_interactive`, `monthly_summary`, `show_risk_report`, `add_rule_interactive`, `list_rules_interactive`, `add_recurring_interactive`, `list_recurring_interactive`, `main_menu`) is the terminal UI (menu options 1–9), built on top of that data layer. **When changing how a transaction, rule, or recurring item is read or written, change the shared function once** — don't patch `web_app.py`'s SQL and `transaction.py`'s SQL separately, they're meant to stay identical by construction, not by manual sync.

**Web form** ([src/web_app.py](src/web_app.py)): a Flask alternative to the CLI, for using the tracker from a phone browser instead of the terminal. Routes mirror the CLI's transaction-related menu options: `/` (add transaction — the only one that's a JS single-page form posting to `POST /api/transactions` via `fetch()`, so it never reloads), `/transactions` (recent list, each row links to `/transactions/<id>/edit` for changing its category — a normal POST-and-redirect form, not AJAX), `/summary` (monthly totals, month picked via a native `<input type="month">` that auto-submits on change), `/risk` (the four Part-4 risk metrics, read-only). Rule and recurring *management* (creating/listing rules or recurring templates — CLI menu 4–7) has no web equivalent — extend the web app only if asked; the data they produce (auto-categorized transactions, auto-generated recurring transactions) already shows up on these pages regardless of which interface created it, since both read the same tables. All pages share one inline CSS block (`BASE_STYLE`, plain string — deliberately not an f-string, so CSS `{ }` don't need escaping) and a nav bar linking between all four main pages. HTML/CSS/JS is inlined via `render_template_string` — no `templates/` folder.

**Auth on the web form**: single shared password, not per-user login (deliberate — see memory `project_web_form_multiuser_phase`: the goal right now is letting many people log transactions with minimal friction, not tracking who entered what). `APP_PASSWORD` is read from the environment and never hardcoded — the app refuses to start without it. A Flask session cookie (`session["authenticated"]`), valid 30 days, gates every route via a `before_request` hook except `/login`; `/api/*` returns 401 JSON instead of a redirect when unauthenticated. `SECRET_KEY` may also be set via env; if omitted it's a random value generated per-process, meaning all sessions invalidate on every restart — acceptable for this use case, don't "fix" it without being asked.

## Code conventions actually in use

- Function/variable/constant names and comments across `transaction.py`, `seed_data.py`, `init_db.py` are in **English**, per docs/THIET-KE.md Part 6. User-facing text passed to `print()`/`input()` stays in **Vietnamese** — that's the target audience's language, not a convention to migrate away from.
- Money is always stored as integer VND (no decimals).
- Timestamps are stored as `TEXT` via `datetime.now().strftime("%Y-%m-%d %H:%M:%S")` / SQLite `datetime('now')`.
