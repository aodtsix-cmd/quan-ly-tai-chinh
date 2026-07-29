/**
 * Runs Code.gs's actual business logic locally under Node, by stubbing the
 * Google Apps Script runtime globals (SpreadsheetApp/PropertiesService/
 * LockService/ContentService/Utilities/Session) with a plain-array fake of
 * one Sheet per tab. No real Google Sheet/deployment needed.
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
    Categories: [["id", "name", "kind", "parent_id"]],
    Transactions: [["id", "occurred_at", "amount", "direction", "account_id", "category_id", "description", "source"]],
  };
}

let sheets = freshSheets();

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

global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: (name) => makeSheetObj(name) }) };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: (key) => (key === "APP_TOKEN" ? "test-token" : null) }) };
global.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
global.ContentService = {
  MimeType: { JSON: "JSON" },
  createTextOutput: (text) => ({ setMimeType: () => ({ getContent: () => text }) }),
};
global.Utilities = {
  formatDate: (date, tz, fmt) => {
    const pad = (n) => String(n).padStart(2, "0");
    if (fmt === "yyyy-MM") return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  },
};
global.Session = { getScriptTimeZone: () => "Asia/Ho_Chi_Minh" };

const codePath = path.join(__dirname, "..", "Code.gs");
eval(fs.readFileSync(codePath, "utf8"));

let passed = 0;
function test(name, fn) {
  sheets = freshSheets();
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
  sheets.Categories.push([1, "An uong", "expense", ""]);
  const result = actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "1tr", description: "An trua" });
  assert.strictEqual(result.amount, 1000000);
  const accRow = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(accRow[3], 0);
});

test("actionAddTransaction_ rejects an invalid account WITHOUT leaving a phantom transaction row", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", ""]);
  assert.throws(() => actionAddTransaction_({ direction: "out", account_id: 999, category_id: 1, amount: "1tr" }));
  assert.strictEqual(sheets.Transactions.length, 1, "only the header row - no orphaned transaction was appended");
});

test("actionAddTransaction_ rejects an inactive account WITHOUT leaving a phantom transaction row", () => {
  sheets.Accounts.push([1, "Old", "cash", 1000000, "FALSE"]);
  sheets.Categories.push([1, "An uong", "expense", ""]);
  assert.throws(() => actionAddTransaction_({ direction: "out", account_id: 1, category_id: 1, amount: "1tr" }));
  assert.strictEqual(sheets.Transactions.length, 1);
});

test("actionAddTransfer_ moves balance between accounts without touching income/expense", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Accounts.push([2, "MoMo", "ewallet", 0, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", ""]);
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
  // Regression test for a real bug found live: the original code validated
  // accounts only inside adjustAccountBalance_, called AFTER both
  // transaction rows were already appended - so a valid fromId would
  // already have money deducted, with no matching credit anywhere, by the
  // time the invalid toId was ever caught. Money would simply disappear.
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 999, amount: "500k" }));
  const bank = sheets.Accounts.find((r) => r[0] === 1);
  assert.strictEqual(bank[3], 1000000, "fromId's balance must be untouched");
  assert.strictEqual(sheets.Transactions.length, 1, "only the header row - no orphaned transaction rows");
});

test("actionAddTransfer_ rejects same source and destination account", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "Chuyen khoan", "transfer", ""]);
  assert.throws(() => actionAddTransfer_({ from_account_id: 1, to_account_id: 1, amount: "1000" }));
});

test("actionDeleteTransaction_ reverses the balance delta", () => {
  sheets.Accounts.push([1, "Bank", "bank", 1000000, true]);
  sheets.Categories.push([1, "An uong", "expense", ""]);
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

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED");
}
