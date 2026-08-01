/**
 * Runs Code.gs's actual business logic locally under Node, by stubbing the
 * Google Apps Script runtime globals (SpreadsheetApp / PropertiesService /
 * LockService / ContentService / Utilities / Session / UrlFetchApp) with a
 * plain-array fake of one Sheet per tab. No real Google Sheet or deployment
 * needed.
 *
 * Run with: node sheet-lite/apps-script/test/test_code.js
 *
 * This covers the money-math-shaped logic worth a permanent test, matching
 * the main Flask app's own convention (tests/ in the repo root). The Apps
 * Script code can't share that Python suite, so it gets this Node equivalent.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function freshSheets() {
  return {
    Accounts: [["id", "name", "type", "balance", "is_active"]],
    Categories: [["id", "name", "kind", "parent_id", "necessity", "stability"]],
    Transactions: [["id", "occurred_at", "amount", "direction", "account_id", "category_id", "description", "source"]],
    PeriodBudgets: [["id", "category_id", "period_id", "amount"]],
    Goals: [["id", "name", "goal_type", "target_amount", "deadline", "account_id", "created_at", "is_active"]],
    Recurring: [["id", "name", "amount", "direction", "account_id", "category_id", "frequency", "next_due", "is_active"]],
    Rules: [["id", "pattern", "category_id", "priority", "hit_count", "created_from"]],
  };
}

let sheets = freshSheets();
let scriptProperties = {};
let fakeToday = new Date(2026, 6, 20); // 2026-07-20 -- month is 0-indexed
let fakeGeminiResponse = null; // set per-test to control UrlFetchApp.fetch's return

function makeSheetObj(name) {
  return {
    getLastRow: () => sheets[name].length,
    getRange: (row, col, numRows, numCols) => {
      if (numRows === undefined) {
        return {
          getValue: () => sheets[name][row - 1][col - 1],
          setValue: (v) => { sheets[name][row - 1][col - 1] = v; },
        };
      }
      return {
        getValues: () => {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const rowArr = [];
            const src = sheets[name][row - 1 + r] || [];
            for (let c = 0; c < numCols; c++) rowArr.push(src[col - 1 + c]);
            out.push(rowArr);
          }
          return out;
        },
        setValues: (vals) => {
          for (let r = 0; r < vals.length; r++) {
            const index = row - 1 + r;
            if (!sheets[name][index]) sheets[name][index] = [];
            for (let c = 0; c < vals[r].length; c++) sheets[name][index][col - 1 + c] = vals[r][c];
          }
        },
      };
    },
    appendRow: (arr) => { sheets[name].push(arr); },
    deleteRow: (rowIndex) => { sheets[name].splice(rowIndex - 1, 1); },
  };
}

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (name) => (sheets[name] ? makeSheetObj(name) : null),
    insertSheet: (name) => { sheets[name] = []; return makeSheetObj(name); },
  }),
};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => (key === "APP_TOKEN" ? "test-token" : (scriptProperties[key] || null)),
  }),
};
global.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
global.ContentService = {
  MimeType: { JSON: "JSON" },
  createTextOutput: (text) => ({ setMimeType: () => ({ getContent: () => text }) }),
};
global.Utilities = {
  formatDate: (date, tz, fmt) => {
    const pad = (n) => String(n).padStart(2, "0");
    if (fmt === "yyyy-MM") return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    if (fmt === "yyyy-MM-dd") return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },
};
global.Session = { getScriptTimeZone: () => "Asia/Ho_Chi_Minh" };
global.UrlFetchApp = {
  fetch: (url, options) => {
    if (fakeGeminiResponse === "network-error") throw new Error("network down");
    return {
      getResponseCode: () => (fakeGeminiResponse && fakeGeminiResponse.code) || 200,
      getContentText: () => JSON.stringify(
        fakeGeminiResponse && fakeGeminiResponse.body !== undefined
          ? fakeGeminiResponse.body
          : { candidates: [{ content: { parts: [{ text: "Tinh hinh on dinh." }] } }] }
      ),
    };
  },
};

// Bootstrap and friends reach "now" through Utilities.formatDate(new Date())
// -- override the global Date constructor's notion of now so every test runs
// against a fixed, hand-computable "today" instead of whatever day it is.
const RealDate = Date;
class FixedNowDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(fakeToday.getTime());
    return new RealDate(...args);
  }
  static now() { return fakeToday.getTime(); }
}
global.Date = FixedNowDate;

const codePath = path.join(__dirname, "..", "Code.gs");
eval(fs.readFileSync(codePath, "utf8"));

let passed = 0;
function test(name, fn) {
  sheets = freshSheets();
  scriptProperties = {};
  fakeGeminiResponse = null;
  try {
    fn();
    console.log("ok -", name);
    passed++;
  } catch (err) {
    console.error("FAIL -", name, "\n   ", err.stack || err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------- amount parsing

test("parseAmountVnd_ handles plain digits and thousands separators", () => {
  assert.strictEqual(parseAmountVnd_("500000"), 500000);
  assert.strictEqual(parseAmountVnd_("1.500.000"), 1500000);
  assert.strictEqual(parseAmountVnd_("1,500,000"), 1500000);
});

test("parseAmountVnd_ handles Vietnamese shorthand", () => {
  assert.strictEqual(parseAmountVnd_("500k"), 500000);
  assert.strictEqual(parseAmountVnd_("1tr"), 1000000);
  assert.strictEqual(parseAmountVnd_("1.5tr"), 1500000);
  assert.strictEqual(parseAmountVnd_("2tr5"), 2500000);
  assert.strictEqual(parseAmountVnd_("2ty"), 2000000000);
});

test("parseAmountVnd_ rejects garbage", () => {
  assert.throws(() => parseAmountVnd_("abc"));
  assert.throws(() => parseAmountVnd_(""));
  assert.throws(() => parseAmountVnd_(null));
});

test("isActive_ treats text FALSE as inactive, not just real boolean false", () => {
  assert.strictEqual(isActive_(false), false);
  assert.strictEqual(isActive_("FALSE"), false);
  assert.strictEqual(isActive_("false"), false);
  assert.strictEqual(isActive_(true), true);
  assert.strictEqual(isActive_("TRUE"), true);
});

test("checkToken_ rejects a wrong token and accepts the right one", () => {
  assert.throws(() => checkToken_("wrong"));
  checkToken_("test-token");
});

// ------------------------------------------------------------- period math

test("periodBounds_ default start day 15: 2026-07-20 falls in 2026-07-15..2026-08-14", () => {
  const bounds = periodBounds_({ year: 2026, month: 7, day: 20 }, 15);
  assert.deepStrictEqual(bounds.start, { year: 2026, month: 7, day: 15 });
  assert.deepStrictEqual(bounds.end, { year: 2026, month: 8, day: 14 });
});

test("periodBounds_ before the 15th falls into the PREVIOUS month's period", () => {
  const bounds = periodBounds_({ year: 2026, month: 7, day: 10 }, 15);
  assert.deepStrictEqual(bounds.start, { year: 2026, month: 6, day: 15 });
  assert.deepStrictEqual(bounds.end, { year: 2026, month: 7, day: 14 });
});

test("periodIdFor_ formats like a calendar month string", () => {
  assert.strictEqual(periodIdFor_({ year: 2026, month: 7, day: 20 }, 15), "2026-07");
  assert.strictEqual(periodIdFor_({ year: 2026, month: 7, day: 10 }, 15), "2026-06");
});

test("shiftPeriodId_ moves forward and backward by whole periods", () => {
  assert.strictEqual(shiftPeriodId_("2026-07", 1, 15), "2026-08");
  assert.strictEqual(shiftPeriodId_("2026-07", -1, 15), "2026-06");
  assert.strictEqual(shiftPeriodId_("2026-12", 1, 15), "2027-01");
});

test("daysElapsedAndRemaining_ counts the as-of day itself as elapsed", () => {
  const info = daysElapsedAndRemaining_({ year: 2026, month: 7, day: 20 }, 15);
  assert.strictEqual(info.total, 31); // Jul 15 .. Aug 14
  assert.strictEqual(info.elapsed, 6); // Jul 15,16,17,18,19,20
  assert.strictEqual(info.remaining, 25);
});

test("recentPeriodIds_ returns oldest-first, excluding current by default", () => {
  assert.deepStrictEqual(recentPeriodIds_("2026-07", 3, 15, false), ["2026-04", "2026-05", "2026-06"]);
});

test("advanceDueDate_ steps by the recurring item's own frequency", () => {
  assert.strictEqual(advanceDueDate_("2026-07-01", "monthly"), "2026-08-01");
  assert.strictEqual(advanceDueDate_("2026-07-01", "quarterly"), "2026-10-01");
  assert.strictEqual(advanceDueDate_("2026-07-01", "yearly"), "2027-07-01");
  assert.strictEqual(advanceDueDate_("2026-07-01", "weekly"), "2026-07-08");
  // Day-clamping: the 31st into a 30-day month lands on the 30th.
  assert.strictEqual(advanceDueDate_("2026-08-31", "monthly"), "2026-09-30");
});

// ------------------------------------------------------------------- setup

test("actionSetup_ creates every missing tab with its header row", () => {
  delete sheets.Recurring;
  delete sheets.Rules;
  const result = actionSetup_({});
  assert.deepStrictEqual(result.created, ["Recurring", "Rules"]);
  assert.deepStrictEqual(sheets.Recurring[0], RECURRING_HEADER);
  assert.deepStrictEqual(sheets.Rules[0], RULES_HEADER);
});

test("actionSetup_ repairs a short header row from an older version in place", () => {
  // A v1 Sheet's Categories tab only had 4 columns (no necessity/stability).
  sheets.Categories = [["id", "name", "kind", "parent_id"], [1, "An uong", "expense", ""]];
  const result = actionSetup_({});
  assert.ok(result.repaired.indexOf("Categories") !== -1);
  assert.deepStrictEqual(sheets.Categories[0], CATEGORIES_HEADER);
  assert.strictEqual(sheets.Categories[1][1], "An uong", "existing data rows must survive the header repair");
});

test("actionSetup_ with seed fills empty Accounts/Categories, and never duplicates on a re-run", () => {
  const first = actionSetup_({ seed: "1" });
  assert.strictEqual(first.seeded.accounts, 4);
  assert.ok(first.seeded.categories > 30);
  const categoryCount = sheets.Categories.length;

  const second = actionSetup_({ seed: "1" });
  assert.strictEqual(second.seeded.accounts, 0, "must not re-seed a non-empty sheet");
  assert.strictEqual(sheets.Categories.length, categoryCount);
});

test("seeded categories include a transfer category and essential expense categories", () => {
  actionSetup_({ seed: "1" });
  const rows = sheets.Categories.slice(1);
  assert.ok(rows.some((r) => r[2] === "transfer"), "a transfer-kind category is required for transfers to work");
  assert.ok(rows.some((r) => r[4] === "essential"), "essential categories drive the risk math");
  assert.ok(rows.some((r) => r[5] === "fixed"), "fixed-stability categories drive rigidity + budget suggestions");
});

// ------------------------------------------------------------ transactions

test("actionAddTransaction_ parses shorthand and updates the account balance", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  const result = actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "1tr", description: "An trua" });
  assert.strictEqual(result.amount, 1000000);
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 0);
});

test("actionAddTransaction_ rejects an invalid account WITHOUT leaving a phantom transaction row", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  assert.throws(() => actionAddTransaction_({ direction: "out", account_id: 999, category_id: 1, amount: "1tr" }));
  assert.strictEqual(sheets.Transactions.length, 1, "only the header row - no orphaned transaction was appended");
});

test("actionAddTransaction_ rejects an inactive account WITHOUT leaving a phantom transaction row", () => {
  sheets.Accounts.push([1, "Old", "cash", 1000000, "FALSE"]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  assert.throws(() => actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "1tr" }));
  assert.strictEqual(sheets.Transactions.length, 1);
});

test("actionAddTransaction_ accepts a backdated occurred_at", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  actionAddTransaction_({ direction: "out", account_id: 1, amount: "100000", occurred_at: "2026-06-03" });
  assert.strictEqual(sheets.Transactions[1][1], "2026-06-03 12:00:00");
  assert.throws(() => actionAddTransaction_({ direction: "out", account_id: 1, amount: "1000", occurred_at: "hom qua" }));
});

test("actionUpdateTransaction_ reverses the old amount before applying the new one", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddTransaction_({ direction: "out", account_id: 1, amount: "300000" });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 700000);

  actionUpdateTransaction_({ id: added.id, amount: "500000" });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 500000);

  // Flipping the direction must swing the balance by the full amount twice.
  actionUpdateTransaction_({ id: added.id, direction: "in" });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 1500000);
});

test("actionUpdateTransaction_ moving a transaction to another account fixes BOTH balances", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  const added = actionAddTransaction_({ direction: "out", account_id: 1, amount: "200000" });
  actionUpdateTransaction_({ id: added.id, account_id: 2 });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 1000000, "old account must be refunded");
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 2)[3], -200000, "new account must be charged");
});

test("actionUpdateTransaction_ rejects an invalid target account without changing anything", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddTransaction_({ direction: "out", account_id: 1, amount: "200000" });
  assert.throws(() => actionUpdateTransaction_({ id: added.id, account_id: 999 }));
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 800000, "balance must be untouched after a rejected edit");
});

test("actionDeleteTransaction_ reverses the balance delta", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddTransaction_({ direction: "out", account_id: 1, amount: "300000" });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 700000);
  actionDeleteTransaction_({ id: added.id });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 1000000);
});

// ---------------------------------------------------------------- transfers

test("actionAddTransfer_ moves balance between accounts without touching income/expense", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  actionAddTransfer_({ from_account_id: 1, to_account_id: 2, amount: "500k", description: "nap vi" });
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 500000);
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 2)[3], 500000);

  const flow = actionBootstrap_().metrics.current_savings_rate;
  assert.strictEqual(flow.income, 0, "transfer must not inflate income");
  assert.strictEqual(flow.expense, 0, "transfer must not inflate expense");
});

test("actionAddTransfer_ with a valid source but invalid destination touches NEITHER balance nor writes any row", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 999, amount: "500k" }));
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 1000000, "source balance must be untouched");
  assert.strictEqual(sheets.Transactions.length, 1, "only the header row - no orphaned transaction rows");
});

test("actionAddTransfer_ rejects same source and destination account", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 1, amount: "1000" }));
});

test("actionAddTransfer_ gives both legs distinct ids", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  const result = actionAddTransfer_({ from_account_id: 1, to_account_id: 2, amount: "100000" });
  assert.notStrictEqual(result.out_id, result.in_id);
  assert.strictEqual(sheets.Transactions.length, 3); // header + 2 legs
});

// ------------------------------------------------------------- recurring

test("generateDueRecurring_ fires a due item once, adjusts the balance, and advances next_due", () => {
  sheets.Accounts.push([1, "Bank", "bank", 5000000, true]);
  sheets.Categories.push([1, "Nha o", "expense", "", "essential", "fixed"]);
  sheets.Recurring.push([1, "Tien nha", 2000000, "out", 1, 1, "monthly", "2026-07-01", true]);

  const boot = actionBootstrap_();
  assert.strictEqual(boot.recurring_generated, 1);
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 3000000);
  assert.strictEqual(sheets.Recurring[1][7], "2026-08-01");
  assert.strictEqual(sheets.Transactions[1][7], "recurring", "generated rows are tagged source=recurring");
});

test("generateDueRecurring_ is idempotent - a second bootstrap the same day generates nothing", () => {
  sheets.Accounts.push([1, "Bank", "bank", 5000000, true]);
  sheets.Recurring.push([1, "Tien nha", 2000000, "out", 1, "", "monthly", "2026-07-01", true]);
  actionBootstrap_();
  const second = actionBootstrap_();
  assert.strictEqual(second.recurring_generated, 0);
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 3000000, "balance must not be charged twice");
});

test("generateDueRecurring_ catches up on several missed periods at once", () => {
  sheets.Accounts.push([1, "Bank", "bank", 10000000, true]);
  sheets.Recurring.push([1, "Tien nha", 1000000, "out", 1, "", "monthly", "2026-05-01", true]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.recurring_generated, 3); // May 1, Jun 1, Jul 1
  assert.strictEqual(sheets.Recurring[1][7], "2026-08-01");
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 7000000);
});

test("generateDueRecurring_ skips inactive items", () => {
  sheets.Accounts.push([1, "Bank", "bank", 5000000, true]);
  sheets.Recurring.push([1, "Da huy", 2000000, "out", 1, "", "monthly", "2026-07-01", "FALSE"]);
  assert.strictEqual(actionBootstrap_().recurring_generated, 0);
  assert.strictEqual(sheets.Accounts.find((r) => r[0] === 1)[3], 5000000);
});

test("short-term forecast subtracts recurring still due later this period", () => {
  sheets.Accounts.push([1, "Bank", "bank", 5000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  // Due 2026-08-01: after today (2026-07-20) but still inside the period,
  // which ends 2026-08-14 - so it must be subtracted from the forecast.
  sheets.Recurring.push([1, "Tien nha", 2000000, "out", 1, 1, "monthly", "2026-08-01", true]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.money.remaining_recurring, 2000000);
  assert.strictEqual(boot.money.forecast_balance, 3000000);
});

// ------------------------------------------------------- auto-categorisation

test("findMatchingRule_ matches case-insensitively on a substring, highest priority first", () => {
  const rules = [
    { id: 1, pattern: "cafe", category_id: 1, priority: 0 },
    { id: 2, pattern: "cafe highlands", category_id: 2, priority: 10 },
  ];
  assert.strictEqual(findMatchingRule_(rules, "Cafe Highlands Q1").category_id, 2);
  assert.strictEqual(findMatchingRule_(rules, "cafe cong").category_id, 1);
  assert.strictEqual(findMatchingRule_(rules, "an trua"), null);
  assert.strictEqual(findMatchingRule_(rules, ""), null);
});

test("actionAddTransaction_ auto-categorises a blank category from a matching rule and bumps hit_count", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Ca phe", "expense", "", "optional", "variable"]);
  sheets.Rules.push([1, "highlands", 1, 0, 0, "user"]);

  const result = actionAddTransaction_({ direction: "out", account_id: 1, amount: "50000", description: "Ca phe Highlands" });
  assert.strictEqual(result.auto_categorised, true);
  assert.strictEqual(Number(result.category_id), 1);
  assert.strictEqual(sheets.Rules[1][4], 1, "hit_count must increment on a match");
});

test("an explicitly chosen category always wins over the rules engine", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Ca phe", "expense", "", "", ""]);
  sheets.Categories.push([2, "An ngoai", "expense", "", "", ""]);
  sheets.Rules.push([1, "highlands", 1, 0, 0, "user"]);

  const result = actionAddTransaction_({ direction: "out", account_id: 1, category_id: 2, amount: "50000", description: "Highlands" });
  assert.strictEqual(result.auto_categorised, false);
  assert.strictEqual(Number(result.category_id), 2);
  assert.strictEqual(sheets.Rules[1][4], 0, "hit_count must not move when no rule was consulted");
});

// -------------------------------------------------------------- risk/health

test("bootstrap health: runway level from essential-spend history", () => {
  sheets.Accounts.push([1, "Bank", "bank", 4000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.health.has_data, true);
  assert.strictEqual(boot.money.essential_expense_per_period, 1000000);
  // runway = 4,000,000 / 1,000,000 = 4 -> "on" band (3 <= x < 6)
  assert.strictEqual(boot.health.runway_level, "on");
  assert.strictEqual(boot.health.level, "on", "no downgrade signals are firing");
});

test("health score downgrades one level when the short-term forecast goes negative", () => {
  sheets.Accounts.push([1, "Bank", "bank", 10000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Categories.push([2, "Mua sam", "expense", "", "optional", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  // Big recent spend -> high daily burn -> negative end-of-period forecast.
  sheets.Transactions.push([2, "2026-07-18 10:00:00", 20000000, "out", 1, 2, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.health.runway_level, "vung"); // 10 periods of runway
  assert.strictEqual(boot.money.at_risk, true);
  assert.strictEqual(boot.health.level, "on", "vung downgraded one level by the at-risk forecast");
  assert.strictEqual(boot.health.downgraded_reasons.length, 1);
});

test("health score never upgrades past what runway alone says", () => {
  sheets.Accounts.push([1, "Bank", "bank", 500000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.health.runway_level, "nguy_hiem"); // 0.5 periods
  assert.strictEqual(boot.health.level, "nguy_hiem");
});

test("bootstrap: no essential-expense history yields has_data=false, no crash", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.health.has_data, false);
  assert.strictEqual(boot.health.runway_level, null);
  assert.deepStrictEqual(boot.alerts, []);
});

test("alerts: runway_danger fires when liquid balance is far below essential spend", () => {
  sheets.Accounts.push([1, "Bank", "bank", 100000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 5000000, "out", 1, 1, "", "manual"]);
  const codes = actionBootstrap_().alerts.map((a) => a.code);
  assert.ok(codes.indexOf("runway_danger") !== -1, "expected runway_danger, got: " + JSON.stringify(codes));
});

test("transfers are excluded from essential-spend and daily-spend math", () => {
  sheets.Accounts.push([1, "Bank", "bank", 4000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Categories.push([2, "Chuyen khoan", "transfer", "", "", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  // A large transfer well inside the 30-day daily-spend window. If it leaked
  // in, forecast_balance would come out hugely negative instead of matching
  // the untouched liquid balance.
  sheets.Transactions.push([2, "2026-07-10 10:00:00", 50000000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([3, "2026-07-10 10:00:00", 50000000, "in", 2, 2, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.money.essential_expense_per_period, 1000000);
  assert.strictEqual(boot.money.forecast_balance, 4000000, "transfer must not count as projected spend");
  assert.strictEqual(boot.money.at_risk, false);
});

test("net worth counts illiquid accounts; liquid balance does not", () => {
  sheets.Accounts.push([1, "Bank", "bank", 5000000, true]);
  sheets.Accounts.push([2, "The tin dung", "credit_card", -2000000, true]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.money.liquid_balance, 5000000);
  assert.strictEqual(boot.money.net_worth, 3000000);
});

test("survival days uses ALL spend including recurring; daily variable spend excludes it", () => {
  sheets.Accounts.push([1, "Bank", "bank", 3000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  sheets.Transactions.push([1, "2026-07-18 10:00:00", 300000, "out", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-07-18 10:00:00", 600000, "out", 1, 1, "", "recurring"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.money.daily_variable_spend, 10000); // 300,000 / 30
  assert.strictEqual(boot.money.daily_total_spend, 30000); // 900,000 / 30
  assert.strictEqual(boot.money.survival_days, 100); // 3,000,000 / 30,000
});

test("50/30/20 balance splits the current period by necessity", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Categories.push([2, "Nha o", "expense", "", "essential", "fixed"]);
  sheets.Categories.push([3, "Giai tri", "expense", "", "optional", "variable"]);
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-07-17 10:00:00", 3000000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([3, "2026-07-18 10:00:00", 2000000, "out", 1, 3, "", "manual"]);
  const balance = actionBootstrap_().metrics.balance_50_30_20;
  assert.strictEqual(balance.essential_pct, 30);
  assert.strictEqual(balance.optional_pct, 20);
  assert.strictEqual(balance.saving_pct, 50);
});

test("spending concentration rolls child categories up into their parent", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Categories.push([2, "Ca phe", "expense", 1, "optional", ""]); // child of An uong
  sheets.Categories.push([3, "Di chuyen", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 300000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([2, "2026-07-17 10:00:00", 200000, "out", 1, 3, "", "manual"]);
  const concentration = actionBootstrap_().metrics.concentration;
  assert.strictEqual(concentration.category_name, "An uong", "the child's spend must roll up to the parent");
  assert.strictEqual(concentration.pct, 60);
});

test("financial rigidity is fixed-category spend over income across completed periods", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Categories.push([2, "Nha o", "expense", "", "essential", "fixed"]);
  sheets.Categories.push([3, "An uong", "expense", "", "essential", "variable"]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-06-21 10:00:00", 4000000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([3, "2026-06-22 10:00:00", 1000000, "out", 1, 3, "", "manual"]);
  const rigidity = actionBootstrap_().metrics.rigidity;
  assert.strictEqual(rigidity.has_data, true);
  assert.strictEqual(rigidity.pct, 40, "only the fixed-stability 4,000,000 counts, not the variable 1,000,000");
});

test("income stability reports a coefficient of variation across completed periods", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Transactions.push([1, "2026-05-20 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-06-20 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  const stability = actionBootstrap_().metrics.income_stability;
  assert.strictEqual(stability.has_data, true);
  assert.strictEqual(stability.cv_pct, 0, "identical income across periods means zero variation");
});

test("savings rate trend reports one entry per completed period, oldest first", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Categories.push([2, "Chi", "expense", "", "", ""]);
  sheets.Transactions.push([1, "2026-05-20 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-05-21 10:00:00", 8000000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([3, "2026-06-20 10:00:00", 10000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([4, "2026-06-21 10:00:00", 5000000, "out", 1, 2, "", "manual"]);
  const trend = actionBootstrap_().metrics.savings_trend;
  assert.deepStrictEqual(trend.periods.map((p) => p.period_id), ["2026-05", "2026-06"]);
  assert.strictEqual(trend.periods[0].rate, 20);
  assert.strictEqual(trend.periods[1].rate, 50);
  assert.strictEqual(trend.trend, "improving");
});

// ------------------------------------------------------------ period budgets

test("actionSetPeriodBudget_ inserts a new budget, then upserts on a second call", () => {
  const first = actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "1tr" });
  assert.strictEqual(first.updated, false);
  assert.strictEqual(sheets.PeriodBudgets.length, 2); // header + 1 row
  const second = actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "2tr" });
  assert.strictEqual(second.updated, true);
  assert.strictEqual(sheets.PeriodBudgets.length, 2, "must update in place, not append a duplicate");
  assert.strictEqual(sheets.PeriodBudgets[1][3], 2000000);
});

test("budget_statuses: pct_used and over_budget computed for the current period", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "1000000" });
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 600000, "out", 1, 1, "", "manual"]);
  const statuses = actionBootstrap_().budget_statuses;
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].spent, 600000);
  assert.strictEqual(statuses[0].pct_used, 60);
  assert.strictEqual(statuses[0].over_budget, false);
});

test("burn rate compares budget spent against time elapsed in the period", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "1000000" });
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 620000, "out", 1, 1, "", "manual"]);
  const burn = actionBootstrap_().metrics.burn_rate;
  assert.strictEqual(burn.has_data, true);
  assert.strictEqual(burn.pct_spent, 62);
  // 6 of 31 days elapsed
  assert.ok(Math.abs(burn.pct_elapsed - (6 / 31 * 100)) < 1e-9);
  assert.ok(burn.ratio > BURN_RATE_DANGER_RATIO);
});

test("an over-budget category raises an alert and downgrades health via burn rate", () => {
  sheets.Accounts.push([1, "Bank", "bank", 10000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "500000" });
  sheets.Transactions.push([2, "2026-07-16 10:00:00", 900000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  assert.ok(boot.alerts.some((a) => a.code === "budget_exceeded"));
  assert.strictEqual(boot.health.runway_level, "vung");
  assert.strictEqual(boot.health.level, "on", "burn rate far above 1.5x downgrades one level");
});

test("budget suggestions average variable-category spend and copy fixed-category budgets", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", "variable"]);
  sheets.Categories.push([2, "Nha o", "expense", "", "essential", "fixed"]);
  // Variable: 900,000 spent across the 3 completed lookback periods -> 300,000 average.
  sheets.Transactions.push([1, "2026-04-20 10:00:00", 300000, "out", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-05-20 10:00:00", 300000, "out", 1, 1, "", "manual"]);
  sheets.Transactions.push([3, "2026-06-20 10:00:00", 300000, "out", 1, 1, "", "manual"]);
  // Fixed: last period's budget is copied verbatim.
  actionSetPeriodBudget_({ category_id: 2, period_id: "2026-06", amount: "4000000" });
  const suggestions = actionBootstrap_().budget_suggestions;
  assert.strictEqual(suggestions[1], 300000);
  assert.strictEqual(suggestions[2], 4000000);
});

// -------------------------------------------------------------------- goals

test("actionAddGoal_ rejects an invalid account before writing any row", () => {
  assert.throws(() => actionAddGoal_({ name: "Quy khan cap", target_amount: "10tr", deadline: "2027-01-01", account_id: 999 }));
  assert.strictEqual(sheets.Goals.length, 1, "only the header row");
});

test("goals: progress_pct and is_overdue computed from the linear schedule", () => {
  sheets.Accounts.push([1, "Bank", "bank", 3000000, true]);
  const added = actionAddGoal_({ name: "Quy khan cap", target_amount: "10000000", deadline: "2026-08-01", account_id: 1 });
  // Backdate created_at so the goal isn't brand-new.
  sheets.Goals.find((r) => r[0] === added.id)[6] = "2026-06-15 00:00:00";
  const goals = actionBootstrap_().goals;
  assert.strictEqual(goals.length, 1);
  assert.strictEqual(goals[0].progress_pct, 30); // 3M / 10M
  assert.strictEqual(goals[0].is_overdue, false); // 2026-08-01 hasn't passed as of 2026-07-20
});

test("an overdue goal is flagged overdue, never also off-track", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddGoal_({ name: "Tre han", target_amount: "10000000", deadline: "2026-06-01", account_id: 1 });
  sheets.Goals.find((r) => r[0] === added.id)[6] = "2026-01-15";
  const goal = actionBootstrap_().goals[0];
  assert.strictEqual(goal.is_overdue, true);
  assert.strictEqual(goal.is_off_track, false, "is_overdue takes precedence");
});

test("actionDeactivateGoal_ removes the goal from bootstrap's active list", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddGoal_({ name: "Test", target_amount: "1000000", deadline: "2027-01-01", account_id: 1 });
  actionDeactivateGoal_({ id: added.id });
  assert.strictEqual(actionBootstrap_().goals.length, 0);
});

test("emergency fund suggestion is 6x the average essential period expense", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 2000000, "out", 1, 1, "", "manual"]);
  assert.strictEqual(actionBootstrap_().money.emergency_fund_target, 12000000);
});

// ----------------------------------------------------------------- forecast

test("actionGetForecast_ extrapolates the recent average flow forward, chaining balance", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Categories.push([2, "Chi tieu", "expense", "", "", ""]);
  // One completed period (2026-06): income 2,000,000, expense 1,500,000.
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 2000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-06-21 10:00:00", 1500000, "out", 1, 2, "", "manual"]);
  const result = actionGetForecast_({ periods_ahead: 2 });
  assert.strictEqual(result.avg_income, 2000000);
  assert.strictEqual(result.avg_expense, 1500000);
  assert.strictEqual(result.periods[0].projected_balance, 1500000); // 1,000,000 + 500,000
  assert.strictEqual(result.periods[1].projected_balance, 2000000); // chained
});

test("actionGetForecast_ subtracts goal contributions only when asked to", () => {
  sheets.Accounts.push([1, "Bank", "bank", 10000000, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "in", 1, 1, "", "manual"]);
  const added = actionAddGoal_({ name: "Xe may", target_amount: "12000000", deadline: "2026-09-01", account_id: 1 });
  sheets.Goals.find((r) => r[0] === added.id)[6] = "2026-07-01";

  const without = actionGetForecast_({ periods_ahead: 1 });
  const withGoals = actionGetForecast_({ periods_ahead: 1, include_goals: "1" });
  assert.strictEqual(without.goal_contribution, 0);
  assert.ok(withGoals.goal_contribution > 0);
  assert.ok(withGoals.periods[0].projected_balance < without.periods[0].projected_balance);
});

// ------------------------------------------------------------------- export

test("actionExportCsv_ emits a header plus one row per transaction, oldest first", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 600000, "out", 1, 1, "Com trua", "manual"]);
  sheets.Transactions.push([2, "2026-06-16 10:00:00", 100000, "out", 1, 1, "Cu hon", "manual"]);
  const result = actionExportCsv_({});
  const lines = result.csv.split("\n");
  assert.strictEqual(result.rows, 2);
  assert.strictEqual(lines[0], "occurred_at,amount,direction,account,category,description,source");
  assert.ok(lines[1].indexOf("2026-06-16") === 0, "oldest transaction must come first");
  assert.ok(lines[2].indexOf("Com trua") !== -1);
});

test("actionExportCsv_ quotes fields containing a comma or quote", () => {
  sheets.Accounts.push([1, "Bank", "bank", 0, true]);
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 1000, "out", 1, "", 'An trua, ca phe "to"', "manual"]);
  const line = actionExportCsv_({}).csv.split("\n")[1];
  assert.ok(line.indexOf('"An trua, ca phe ""to"""') !== -1, "got: " + line);
});

// ---------------------------------------------------- backward compatibility

test("bootstrap still works on an older Sheet missing the v2/v3 tabs", () => {
  // Simulates upgrading Code.gs before adding the newer tabs to a live
  // Sheet: bootstrap must degrade to empty lists, not throw and take the
  // whole page down.
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  delete sheets.PeriodBudgets;
  delete sheets.Goals;
  delete sheets.Recurring;
  delete sheets.Rules;
  const boot = actionBootstrap_();
  assert.deepStrictEqual(boot.budget_statuses, []);
  assert.deepStrictEqual(boot.goals, []);
  assert.deepStrictEqual(boot.recurring, []);
  assert.deepStrictEqual(boot.rules, []);
  assert.strictEqual(boot.recurring_generated, 0);
});

test("a write action against a missing tab gives a clear error, not a silent no-op", () => {
  delete sheets.Goals;
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  assert.throws(
    () => actionAddGoal_({ name: "X", target_amount: "1tr", deadline: "2027-01-01", account_id: 1 }),
    /Goals/
  );
});

// ----------------------------------------------------------------------- AI

test("actionGetAiSummary_ is gracefully unavailable with no GEMINI_API_KEY set", () => {
  const result = actionGetAiSummary_({});
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, "no_key");
});

test("actionGetAiSummary_ returns the model's text when a key is set and the call succeeds", () => {
  scriptProperties.GEMINI_API_KEY = "fake-key";
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  fakeGeminiResponse = { code: 200, body: { candidates: [{ content: { parts: [{ text: "  Tinh hinh on dinh.  " }] } }] } };
  const result = actionGetAiSummary_({});
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.summary, "Tinh hinh on dinh.");
});

test("actionGetAiSummary_ degrades gracefully (never throws) when the API call fails", () => {
  scriptProperties.GEMINI_API_KEY = "fake-key";
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  fakeGeminiResponse = "network-error";
  const result = actionGetAiSummary_({});
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, "network");
});

test("actionGetAiSummary_ degrades gracefully on a non-2xx response", () => {
  scriptProperties.GEMINI_API_KEY = "fake-key";
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  fakeGeminiResponse = { code: 429, body: {} };
  assert.strictEqual(actionGetAiSummary_({}).reason, "network");
});

test("actionGetAiAdvice_ rejects an unknown topic instead of prompting blind", () => {
  scriptProperties.GEMINI_API_KEY = "fake-key";
  assert.strictEqual(actionGetAiAdvice_({ topic: "nonsense" }).available, false);
});

test("actionGetAiAdvice_ returns advice for a known topic", () => {
  scriptProperties.GEMINI_API_KEY = "fake-key";
  fakeGeminiResponse = { code: 200, body: { candidates: [{ content: { parts: [{ text: "Uu tien quy khan cap." }] } }] } };
  const result = actionGetAiAdvice_({ topic: "goals", context: "{}" });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.advice, "Uu tien quy khan cap.");
});

// ---------------------------------------------------------------- dispatch

test("handle_ returns ok:false with a message instead of throwing on a bad action", () => {
  const output = handle_({ parameter: { token: "test-token", action: "khong_ton_tai" } }, "GET");
  const parsed = JSON.parse(output.getContent());
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.message.indexOf("khong_ton_tai") !== -1);
});

test("handle_ rejects a request with a wrong token before running any action", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const output = handle_({ parameter: { token: "nope", action: "bootstrap" } }, "GET");
  assert.strictEqual(JSON.parse(output.getContent()).ok, false);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED");
}
