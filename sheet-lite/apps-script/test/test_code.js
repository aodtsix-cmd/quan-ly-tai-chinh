/**
 * Runs Code.gs's actual business logic locally under Node, by stubbing the
 * Google Apps Script runtime globals (SpreadsheetApp/PropertiesService/
 * LockService/ContentService/Utilities/Session/UrlFetchApp) with a plain-
 * array fake of one Sheet per tab. No real Google Sheet/deployment needed.
 *
 * Run with: node sheet-lite/apps-script/test/test_code.js
 *
 * This is the money-math-shaped logic worth a permanent test, matching the
 * main Flask app's own testing convention (tests/ in the repo root) — the
 * Apps Script code can't share that Python test suite, so it gets this
 * small Node-based equivalent instead.
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
            for (let c = 0; c < numCols; c++) rowArr.push(sheets[name][row - 1 + r][col - 1 + c]);
            out.push(rowArr);
          }
          return out;
        },
      };
    },
    appendRow: (arr) => { sheets[name].push(arr); },
    deleteRow: (rowIndex) => { sheets[name].splice(rowIndex - 1, 1); },
  };
}

global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: (name) => (sheets[name] ? makeSheetObj(name) : null) }) };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: (key) => (key === "APP_TOKEN" ? "test-token" : (scriptProperties[key] || null)) }) };
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

// actionBootstrap_/actionGetForecast_ etc. call todayParts_() -> real Date()
// under the hood via Utilities.formatDate(new Date(), ...) - override the
// global Date constructor's "now" so every test runs against a fixed,
// hand-computable "today" instead of whatever day it happens to be.
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
    console.error("FAIL -", name, "\n   ", err.message);
    process.exitCode = 1;
  }
}

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

test("actionBootstrap_ excludes inactive accounts (incl. text-FALSE ones)", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "Old", "cash", 999999, "FALSE"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.accounts.length, 1);
  assert.strictEqual(boot.accounts[0].id, 1);
});

test("actionAddTransaction_ parses shorthand and updates the account balance", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  const result = actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "1tr", description: "An trua" });
  assert.strictEqual(result.amount, 1000000);
  const accRow = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(accRow[3], 0);
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

test("actionAddTransfer_ moves balance between accounts without touching income/expense", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  actionAddTransfer_({ from_account_id: 1, to_account_id: 2, amount: "500k", description: "nap vi" });
  const bank = sheets.Accounts.find((r) => r[0] === 1);
  const momo = sheets.Accounts.find((r) => r[0] === 2);
  assert.strictEqual(bank[3], 500000);
  assert.strictEqual(momo[3], 500000);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.summary.income, 0, "transfer must not inflate income");
  assert.strictEqual(boot.summary.expense, 0, "transfer must not inflate expense");
});

test("actionAddTransfer_ with a valid source but invalid destination touches NEITHER balance nor writes any row", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 999, amount: "500k" }));
  const bank = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(bank[3], 1000000, "fromId's balance must be untouched");
  assert.strictEqual(sheets.Transactions.length, 1, "only the header row - no orphaned transaction rows");
});

test("actionAddTransfer_ rejects same source and destination account", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", "", "", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 1, amount: "1000" }));
});

test("actionDeleteTransaction_ reverses the balance delta", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  const added = actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "300000" });
  let accRow = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(accRow[3], 700000);
  actionDeleteTransaction_({ id: added.id });
  accRow = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(accRow[3], 1000000);
});

test("checkToken_ rejects a wrong token and accepts the right one", () => {
  assert.throws(() => checkToken_("wrong"));
  checkToken_("test-token");
});

// ---------- Period math ----------

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
  const ids = recentPeriodIds_("2026-07", 3, 15, false);
  assert.deepStrictEqual(ids, ["2026-04", "2026-05", "2026-06"]);
});

// ---------- Risk / alerts ----------

test("bootstrap risk: runway level and short-term forecast with essential spend history", () => {
  sheets.Accounts.push([1, "Bank", "bank", 4000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Categories.push([2, "Luong", "income", "", "", ""]);
  // One completed period (2026-06) with 1,000,000 essential spend -> avg = 1,000,000
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.risk.has_data, true);
  assert.strictEqual(boot.risk.essential_expense, 1000000);
  // runway = 4,000,000 / 1,000,000 = 4 months -> "on" band (3 <= x < 6)
  assert.strictEqual(boot.risk.runway_level, "on");
});

test("actionBootstrap_ still works on a v1 Sheet that never added the PeriodBudgets/Goals tabs", () => {
  // Simulates an existing v1 user upgrading to this v2 Code.gs before
  // adding the new tabs to their live Sheet - bootstrap must degrade to
  // empty budgets/goals, not throw and break the whole page.
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  delete sheets.PeriodBudgets;
  delete sheets.Goals;
  const boot = actionBootstrap_();
  assert.deepStrictEqual(boot.budget_statuses, []);
  assert.deepStrictEqual(boot.goals, []);
});

test("bootstrap risk: no essential-expense history yields has_data=false, no crash", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.risk.has_data, false);
  assert.strictEqual(boot.risk.runway_level, null);
  assert.deepStrictEqual(boot.alerts, []);
});

test("bootstrap alerts: runway_danger fires when liquid balance is far below essential spend", () => {
  sheets.Accounts.push([1, "Bank", "bank", 100000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 5000000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  const codes = boot.alerts.map((a) => a.code);
  assert.ok(codes.indexOf("runway_danger") !== -1, "expected runway_danger alert, got: " + JSON.stringify(codes));
});

test("bootstrap risk/alerts: transfer transactions are excluded from essential-spend and daily-spend math", () => {
  sheets.Accounts.push([1, "Bank", "bank", 4000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "essential", ""]);
  sheets.Categories.push([2, "Chuyen khoan", "transfer", "", "", ""]);
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 1000000, "out", 1, 1, "", "manual"]);
  // A large transfer, well within the 30-day daily-spend lookback window,
  // that must NOT count as either essential spend or "daily spend" (which
  // feeds the short-term forecast) - if it leaked in, forecast_balance
  // would come out hugely negative instead of matching the untouched
  // liquid balance.
  sheets.Transactions.push([2, "2026-07-10 10:00:00", 50000000, "out", 1, 2, "", "manual"]);
  sheets.Transactions.push([3, "2026-07-10 10:00:00", 50000000, "in", 2, 2, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.risk.essential_expense, 1000000);
  assert.strictEqual(boot.risk.forecast_balance, 4000000, "transfer must not be counted as projected spend");
  assert.strictEqual(boot.risk.at_risk, false);
});

// ---------- Period budgets ----------

test("actionSetPeriodBudget_ inserts a new budget, then upserts (updates in place) on a second call", () => {
  const first = actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "1tr" });
  assert.strictEqual(first.updated, false);
  assert.strictEqual(sheets.PeriodBudgets.length, 2); // header + 1 row
  const second = actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "2tr" });
  assert.strictEqual(second.updated, true);
  assert.strictEqual(sheets.PeriodBudgets.length, 2, "must update the existing row, not append a duplicate");
  assert.strictEqual(sheets.PeriodBudgets[1][3], 2000000);
});

test("bootstrap budget_statuses: pct_used and over_budget computed correctly for the current period", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", "", "", ""]);
  actionSetPeriodBudget_({ category_id: 1, period_id: "2026-07", amount: "1000000" });
  sheets.Transactions.push([1, "2026-07-16 10:00:00", 600000, "out", 1, 1, "", "manual"]);
  const boot = actionBootstrap_();
  assert.strictEqual(boot.budget_statuses.length, 1);
  assert.strictEqual(boot.budget_statuses[0].spent, 600000);
  assert.strictEqual(boot.budget_statuses[0].pct_used, 60);
  assert.strictEqual(boot.budget_statuses[0].over_budget, false);
});

// ---------- Goals ----------

test("actionAddGoal_ rejects an invalid account before writing any row", () => {
  assert.throws(() => actionAddGoal_({ name: "Quy khan cap", target_amount: "10tr", deadline: "2027-01-01", account_id: 999 }));
  assert.strictEqual(sheets.Goals.length, 1, "only the header row");
});

test("bootstrap goals: progress_pct and is_overdue computed from linear schedule", () => {
  sheets.Accounts.push([1, "Bank", "bank", 3000000, true]);
  const added = actionAddGoal_({ name: "Quy khan cap", target_amount: "10000000", deadline: "2026-08-01", account_id: 1 });
  // Backdate created_at so the goal isn't brand-new (created "today" would
  // make elapsed_periods trivially small) - simulate it having been created
  // a full period ago.
  const row = sheets.Goals.find((r) => r[0] === added.id);
  row[6] = "2026-06-15 00:00:00";
  const boot = actionBootstrap_();
  assert.strictEqual(boot.goals.length, 1);
  assert.strictEqual(boot.goals[0].progress_pct, 30); // 3M / 10M
  assert.strictEqual(boot.goals[0].is_overdue, false); // deadline 2026-08-01 hasn't passed as of 2026-07-20
});

test("actionDeactivateGoal_ removes the goal from bootstrap's active list", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  const added = actionAddGoal_({ name: "Test", target_amount: "1000000", deadline: "2027-01-01", account_id: 1 });
  actionDeactivateGoal_({ id: added.id });
  const boot = actionBootstrap_();
  assert.strictEqual(boot.goals.length, 0);
});

// ---------- Forecast ----------

test("actionGetForecast_ extrapolates the recent average flow forward, chaining balance", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Luong", "income", "", "", ""]);
  sheets.Categories.push([2, "Chi tieu", "expense", "", "", ""]);
  // One completed period (2026-06): income 2,000,000, expense 1,500,000 -> net +500,000/period
  sheets.Transactions.push([1, "2026-06-20 10:00:00", 2000000, "in", 1, 1, "", "manual"]);
  sheets.Transactions.push([2, "2026-06-21 10:00:00", 1500000, "out", 1, 2, "", "manual"]);
  const result = actionGetForecast_({ periods_ahead: 2 });
  assert.strictEqual(result.avg_income, 2000000);
  assert.strictEqual(result.avg_expense, 1500000);
  assert.strictEqual(result.periods.length, 2);
  assert.strictEqual(result.periods[0].projected_balance, 1500000); // 1,000,000 + 500,000
  assert.strictEqual(result.periods[1].projected_balance, 2000000); // chained: +500,000 again
});

// ---------- AI summary ----------

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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED");
}
