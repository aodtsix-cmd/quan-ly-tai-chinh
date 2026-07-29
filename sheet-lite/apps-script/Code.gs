/**
 * Quan ly tai chinh ca nhan - ban Sheet-lite.
 *
 * Google Sheets is the database; this Apps Script, deployed as a Web App,
 * is the thin API layer between the static HTML frontend (index.html,
 * hosted anywhere - GitHub Pages, or just opened locally) and the Sheet.
 * A static page cannot safely write to a Sheet directly (no clean way to
 * embed write credentials in public client-side code) - Apps Script solves
 * that by running server-side under the sheet owner's own permissions.
 *
 * Same core data model as the main Flask+SQLite app (accounts/categories/
 * transactions, amount always positive with direction carrying the sign,
 * transfers tagged with a transfer-kind category rather than a third
 * direction value) - deliberately kept consistent so this version can grow
 * into more of that app's features later without a data-model rewrite.
 *
 * ---- One-time setup ----
 * 1. Create a new Google Sheet. Create three tabs named exactly:
 *    Accounts, Categories, Transactions (see the header rows below).
 * 2. Extensions > Apps Script. Paste this whole file in as Code.gs.
 * 3. Project Settings > Script Properties > add a property named APP_TOKEN
 *    with a value you pick (this is your shared password - same idea as
 *    the main app's APP_PASSWORD, matches this project's existing
 *    single-shared-password-for-personal-use convention).
 * 4. Deploy > New deployment > type "Web app". Execute as "Me", who has
 *    access "Anyone with the link". Copy the deployment URL.
 * 5. Paste that URL and your APP_TOKEN into index.html's config prompt
 *    (asked once, then remembered in the browser via localStorage).
 */

var SHEET_ACCOUNTS = "Accounts";
var SHEET_CATEGORIES = "Categories";
var SHEET_TRANSACTIONS = "Transactions";

var ACCOUNTS_HEADER = ["id", "name", "type", "balance", "is_active"];
var CATEGORIES_HEADER = ["id", "name", "kind", "parent_id"];
var TRANSACTIONS_HEADER = ["id", "occurred_at", "amount", "direction", "account_id", "category_id", "description", "source"];

function doGet(e) {
  return handle_(e, "GET");
}

function doPost(e) {
  return handle_(e, "POST");
}

function handle_(e, method) {
  try {
    var params = method === "GET" ? (e.parameter || {}) : JSON.parse((e.postData && e.postData.contents) || "{}");
    checkToken_(params.token);

    var action = params.action;
    var result;
    if (action === "bootstrap") {
      result = actionBootstrap_();
    } else if (action === "add_account") {
      result = withLock_(function () { return actionAddAccount_(params); });
    } else if (action === "add_category") {
      result = withLock_(function () { return actionAddCategory_(params); });
    } else if (action === "add_transaction") {
      result = withLock_(function () { return actionAddTransaction_(params); });
    } else if (action === "add_transfer") {
      result = withLock_(function () { return actionAddTransfer_(params); });
    } else if (action === "delete_transaction") {
      result = withLock_(function () { return actionDeleteTransaction_(params); });
    } else {
      throw new Error("Hanh dong khong hop le: " + action);
    }
    return jsonOutput_({ ok: true, data: result });
  } catch (err) {
    return jsonOutput_({ ok: false, message: String(err.message || err) });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty("APP_TOKEN");
  if (!expected) {
    throw new Error("Chua dat APP_TOKEN trong Script Properties.");
  }
  if (token !== expected) {
    throw new Error("Sai token.");
  }
}

// A personal single-user tool basically never sees concurrent writes, but
// double-tapping "save" or having two tabs open is a real (if rare) way to
// race two appends together - this is the cheap, standard fix, not
// over-engineering for a scenario that can't happen.
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error("Khong tim thay sheet: " + name);
  }
  return sheet;
}

function sheetRowsAsObjects_(sheet, header) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = values[i][c];
    }
    // Skip fully-blank trailing rows (Sheets sometimes reports a longer
    // lastRow than there's real data in edge cases).
    if (obj.id !== "" && obj.id !== null) rows.push(obj);
  }
  return rows;
}

function nextId_(sheet, header) {
  var rows = sheetRowsAsObjects_(sheet, header);
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    max = Math.max(max, Number(rows[i].id) || 0);
  }
  return max + 1;
}

function findRowIndexById_(sheet, header, id) {
  var rows = sheetRowsAsObjects_(sheet, header);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].id) === Number(id)) return i + 2; // +2: header row + 1-indexing
  }
  return -1;
}

// ---------- Amount parsing (mirrors transaction.parse_amount_vnd) ----------
//
// Same Vietnamese-shorthand-aware parser as the main Flask app's
// transaction.parse_amount_vnd - ported here rather than shared, since this
// is a separate JS runtime with no code-sharing mechanism with the Python
// app. Keep the two in sync by hand if either changes.
var AMOUNT_UNIT_MULTIPLIERS = {
  k: 1e3, nghin: 1e3, "nghìn": 1e3,
  tr: 1e6, trieu: 1e6, "triệu": 1e6,
  ty: 1e9, "tỷ": 1e9,
};

function parseAmountVnd_(raw) {
  if (raw === null || raw === undefined) throw new Error("Chua nhap so tien.");
  var text = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!text) throw new Error("Chua nhap so tien.");

  var trailingDigitMatch = text.match(/^(\d+)(tr|trieu|triệu)(\d)$/);
  if (trailingDigitMatch) {
    var whole = Number(trailingDigitMatch[1]);
    var tenths = Number(trailingDigitMatch[3]);
    return Math.round((whole + tenths / 10) * 1e6);
  }

  var unitMatch = text.match(/^(\d+(?:[.,]\d+)?)(k|nghin|nghìn|tr|trieu|triệu|ty|tỷ)$/);
  if (unitMatch) {
    var value = parseFloat(unitMatch[1].replace(",", "."));
    return Math.round(value * AMOUNT_UNIT_MULTIPLIERS[unitMatch[2]]);
  }

  var digitsOnly = text.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digitsOnly)) {
    throw new Error('Khong hieu so tien "' + raw + '" (vd: 500000, 500k, 1tr, 2tr5).');
  }
  return parseInt(digitsOnly, 10);
}

// ---------- Actions ----------

// Sheets can hand back a real boolean (checkbox cell) OR literal text
// ("TRUE"/"FALSE") depending on how a cell was set - a plain truthy check
// would treat the text "FALSE" as active, since a non-empty string is
// always truthy in JS. Worth guarding since typing FALSE as text is a very
// natural thing to do in a spreadsheet, not an exotic edge case.
function isActive_(value) {
  return value !== false && value !== "FALSE" && value !== "false" && value !== "" && value !== 0;
}

function actionBootstrap_() {
  var accounts = sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER).filter(function (a) { return isActive_(a.is_active); });
  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  transactions.sort(function (a, b) { return (a.occurred_at < b.occurred_at) ? 1 : -1; });

  var accountNameById = {};
  accounts.forEach(function (a) { accountNameById[a.id] = a.name; });
  var categoryNameById = {};
  categories.forEach(function (c) { categoryNameById[c.id] = c.name; });

  var recent = transactions.slice(0, 100).map(function (t) {
    return {
      id: t.id, occurred_at: t.occurred_at, amount: t.amount, direction: t.direction,
      account_name: accountNameById[t.account_id] || "?",
      category_name: categoryNameById[t.category_id] || "",
      description: t.description,
    };
  });

  var transferCategoryIds = {};
  categories.forEach(function (c) { if (c.kind === "transfer") transferCategoryIds[c.id] = true; });
  var income = 0, expense = 0;
  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  transactions.forEach(function (t) {
    if (String(t.occurred_at).slice(0, 7) !== thisMonth) return;
    if (transferCategoryIds[t.category_id]) return; // moved between own accounts, not real income/expense
    if (t.direction === "in") income += Number(t.amount);
    else expense += Number(t.amount);
  });

  return {
    accounts: accounts,
    categories: categories,
    transactions: recent,
    summary: { income: income, expense: expense, month: thisMonth },
  };
}

function actionAddAccount_(params) {
  var name = String(params.name || "").trim();
  if (!name) throw new Error("Ten tai khoan khong duoc de trong.");
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var id = nextId_(sheet, ACCOUNTS_HEADER);
  sheet.appendRow([id, name, params.type || "bank", 0, true]);
  return { id: id };
}

function actionAddCategory_(params) {
  var name = String(params.name || "").trim();
  var kind = params.kind;
  if (!name) throw new Error("Ten danh muc khong duoc de trong.");
  if (["expense", "income", "transfer"].indexOf(kind) === -1) throw new Error("Loai danh muc khong hop le.");
  var sheet = getSheet_(SHEET_CATEGORIES);
  var id = nextId_(sheet, CATEGORIES_HEADER);
  sheet.appendRow([id, name, kind, params.parent_id || ""]);
  return { id: id };
}

// Validates an account exists AND is active, returning its sheet row index.
// Deliberately called BEFORE any appendRow in the actions below (found and
// fixed live: the original order validated the account only inside
// adjustAccountBalance_, AFTER the transaction row(s) were already
// appended - Sheets writes can't be rolled back like a SQLite transaction,
// so an invalid account left a phantom transaction row pointing nowhere,
// and in actionAddTransfer_'s case specifically, a *valid* fromId could
// already have money deducted before an invalid toId was ever caught,
// with no matching credit anywhere - a real money-disappears bug).
function findActiveAccountRowIndex_(accountId) {
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var rows = sheetRowsAsObjects_(sheet, ACCOUNTS_HEADER);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].id) === Number(accountId) && isActive_(rows[i].is_active)) return i + 2;
  }
  throw new Error("Tai khoan khong hop le.");
}

function adjustAccountBalance_(accountId, delta) {
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var rowIndex = findActiveAccountRowIndex_(accountId);
  var balanceCol = ACCOUNTS_HEADER.indexOf("balance") + 1;
  var cell = sheet.getRange(rowIndex, balanceCol);
  cell.setValue(Number(cell.getValue()) + delta);
}

function actionAddTransaction_(params) {
  var direction = params.direction;
  if (direction !== "in" && direction !== "out") throw new Error("Loai giao dich khong hop le.");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  var accountId = Number(params.account_id);
  findActiveAccountRowIndex_(accountId); // throws before any write if invalid

  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var id = nextId_(sheet, TRANSACTIONS_HEADER);
  var occurredAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([id, occurredAt, amount, direction, accountId, params.category_id || "", params.description || "", "manual"]);

  adjustAccountBalance_(accountId, direction === "in" ? amount : -amount);
  return { id: id, amount: amount };
}

function actionAddTransfer_(params) {
  var fromId = Number(params.from_account_id);
  var toId = Number(params.to_account_id);
  if (fromId === toId) throw new Error("Tai khoan nguon va dich phai khac nhau.");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  // Validate BOTH accounts before any write - see findActiveAccountRowIndex_'s
  // own comment for why this order matters.
  findActiveAccountRowIndex_(fromId);
  findActiveAccountRowIndex_(toId);

  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transferCategory = categories.filter(function (c) { return c.kind === "transfer"; })[0];
  if (!transferCategory) throw new Error("Chua co danh muc Chuyen khoan - vao tab Categories them 1 dong kind=transfer.");

  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var occurredAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  var description = params.description || "";

  var outId = nextId_(sheet, TRANSACTIONS_HEADER);
  sheet.appendRow([outId, occurredAt, amount, "out", fromId, transferCategory.id, description, "manual"]);
  var inId = nextId_(sheet, TRANSACTIONS_HEADER);
  sheet.appendRow([inId, occurredAt, amount, "in", toId, transferCategory.id, description, "manual"]);

  adjustAccountBalance_(fromId, -amount);
  adjustAccountBalance_(toId, amount);
  return { out_id: outId, in_id: inId };
}

function actionDeleteTransaction_(params) {
  var id = Number(params.id);
  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var rowIndex = findRowIndexById_(sheet, TRANSACTIONS_HEADER, id);
  if (rowIndex === -1) return { deleted: false };

  var row = sheet.getRange(rowIndex, 1, 1, TRANSACTIONS_HEADER.length).getValues()[0];
  var amount = Number(row[TRANSACTIONS_HEADER.indexOf("amount")]);
  var direction = row[TRANSACTIONS_HEADER.indexOf("direction")];
  var accountId = row[TRANSACTIONS_HEADER.indexOf("account_id")];

  sheet.deleteRow(rowIndex);
  adjustAccountBalance_(accountId, direction === "in" ? -amount : amount);
  return { deleted: true };
}
