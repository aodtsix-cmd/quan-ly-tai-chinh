/**
 * So tai chinh - ban Sheet-lite (v3).
 *
 * Google Sheets is the database; this Apps Script, deployed as a Web App, is
 * the thin API layer between the static frontend (../index.html, hosted on
 * GitHub Pages or opened locally) and the Sheet. A static page cannot safely
 * write to a Sheet directly - there is no clean way to embed write
 * credentials in public client-side code - so Apps Script runs server-side
 * under the sheet owner's own permissions and does it instead.
 *
 * Same core data model as the main Flask+SQLite app in ../../src: accounts /
 * categories / transactions, amount always positive with `direction`
 * carrying the sign, internal transfers tagged with a transfer-kind category
 * rather than a third direction value.
 *
 * ---- What v3 added over v2 ----
 *   - actionSetup_: creates any missing tab (with its header row) and can
 *     seed the same default accounts/categories as the main app's
 *     seed_data.py. Replaces the old "create 5 tabs by hand" setup step and
 *     doubles as the upgrade path for older Sheets.
 *   - Recurring tab + generateDueRecurring_: mirrors the main app's
 *     `recurring` table and generate_due_recurring(). Runs on every
 *     bootstrap, idempotent within a day.
 *   - Rules tab + applyMatchingRule_: mirrors the main app's `rules` table -
 *     auto-categorises a transaction from its description when no category
 *     was picked.
 *   - update_transaction: editing a saved transaction (amount, direction,
 *     account, category, description, date) with the correct balance
 *     reversal. v2 could only delete-and-retype.
 *   - Backdating: add_transaction accepts occurred_at, so a transaction can
 *     be logged for a past day instead of always "now".
 *   - Health score + component metrics, mirroring risk.py's Moc 5 set:
 *     survival days, financial rigidity, burn rate vs elapsed, current
 *     period savings rate, spending concentration, income stability, budget
 *     streak, net worth, savings rate trend, 50/30/20 balance.
 *   - Budget suggestions from spend history (suggest_period_budget_amounts).
 *   - export_csv, get_ai_advice.
 *
 * ---- Deliberately still simpler than the main app ----
 *   - The cashflow forecast is risk.project_simple_trajectory (flat
 *     historical-average extrapolation), not Moc 4's richer model: no
 *     seasonality detection, no macro context, nothing persisted.
 *   - No spending_simulations storage - the simulator runs client-side off
 *     bootstrap data and is not saved.
 *   - No behavior_events, no event plans, no OCR screenshot import.
 *   - No AI response caching (the main app's ai_cache table): each AI call
 *     hits Gemini directly. Calls are user-initiated or once per page load,
 *     so this stays well inside the free tier.
 *
 * ---- One-time setup ----
 * 1. Create a new Google Sheet. Extensions > Apps Script, paste this file in
 *    as Code.gs. (No need to create tabs by hand - step 4 does it.)
 * 2. Project Settings > Script Properties:
 *      APP_TOKEN        (required) - shared password, same idea as the main
 *                       app's APP_PASSWORD.
 *      PERIOD_START_DAY (optional, default 15) - which day of the month your
 *                       "ky tai chinh" starts on.
 *      GEMINI_API_KEY   (optional) - only for the AI features; everything
 *                       else works without it. Free key at
 *                       https://aistudio.google.com/apikey
 *    Set Time zone to (GMT+07:00) Vietnam Time on this same page.
 * 3. Deploy > New deployment > "Web app", execute as "Me", access "Anyone
 *    with the link". Copy the deployment URL.
 * 4. Open the frontend, paste the URL + APP_TOKEN, then press "Tao cac tab
 *    con thieu" - that calls actionSetup_ and builds the whole Sheet.
 */

// ---------------------------------------------------------------- constants

// Bumped whenever Code.gs changes in a way the frontend can notice. The page
// shows this in Cài đặt, which is how you can tell at a glance whether a
// redeploy actually took - forgetting to pick "Phiên bản: Mới" when
// redeploying is the single easiest mistake to make with Apps Script, and it
// fails silently: the old code just keeps serving.
var VERSION = "3.2";

var SHEET_ACCOUNTS = "Accounts";
var SHEET_CATEGORIES = "Categories";
var SHEET_TRANSACTIONS = "Transactions";
var SHEET_PERIOD_BUDGETS = "PeriodBudgets";
var SHEET_GOALS = "Goals";
var SHEET_RECURRING = "Recurring";
var SHEET_RULES = "Rules";

var ACCOUNTS_HEADER = ["id", "name", "type", "balance", "is_active"];
// necessity: "essential" | "optional" | "" - drives the risk math below.
// stability: "fixed" | "variable" | "" - drives budget suggestions and the
// financial-rigidity metric.
var CATEGORIES_HEADER = ["id", "name", "kind", "parent_id", "necessity", "stability"];
var TRANSACTIONS_HEADER = ["id", "occurred_at", "amount", "direction", "account_id", "category_id", "description", "source"];
var PERIOD_BUDGETS_HEADER = ["id", "category_id", "period_id", "amount"];
var GOALS_HEADER = ["id", "name", "goal_type", "target_amount", "deadline", "account_id", "created_at", "is_active"];
var RECURRING_HEADER = ["id", "name", "amount", "direction", "account_id", "category_id", "frequency", "next_due", "is_active"];
var RULES_HEADER = ["id", "pattern", "category_id", "priority", "hit_count", "created_from"];

var ALL_TABS = [
  { name: SHEET_ACCOUNTS, header: ACCOUNTS_HEADER },
  { name: SHEET_CATEGORIES, header: CATEGORIES_HEADER },
  { name: SHEET_TRANSACTIONS, header: TRANSACTIONS_HEADER },
  { name: SHEET_PERIOD_BUDGETS, header: PERIOD_BUDGETS_HEADER },
  { name: SHEET_GOALS, header: GOALS_HEADER },
  { name: SHEET_RECURRING, header: RECURRING_HEADER },
  { name: SHEET_RULES, header: RULES_HEADER },
];

var SPEND_LOOKBACK_DAYS = 30;
var ESSENTIAL_LOOKBACK_PERIODS = 3;
var BASELINE_FLOW_LOOKBACK_PERIODS = 3;
var TREND_LOOKBACK_PERIODS = 6;
var RIGIDITY_LOOKBACK_PERIODS = 3;
var RECENT_TRANSACTION_LIMIT = 150;

var RUNWAY_DANGER_MONTHS = 1;
var RUNWAY_FRAGILE_MONTHS = 3;
var RUNWAY_OK_MONTHS = 6;
var BURN_RATE_DANGER_RATIO = 1.5;
var EMERGENCY_FUND_PERIODS = 6;

// Ordered worst -> best. get_health_score only ever moves DOWN this list.
var HEALTH_LEVELS = ["nguy_hiem", "mong_manh", "on", "vung"];

// A recurring row whose next_due is far in the past shouldn't spin forever
// generating years of back-transactions on one page load.
var RECURRING_CATCHUP_LIMIT = 60;

// ------------------------------------------------------- one-click bootstrap
//
// Everything below runs from the spreadsheet itself, so the whole setup is
// "paste this file, pick one menu item, deploy". No hand-created tabs, no
// hand-typed Script Properties, no hand-set timezone - each of those was a
// separate way for setup to go quietly wrong.

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("Sổ tài chính")
      .addItem("① Thiết lập bảng tính", "setupEverything")
      .addItem("② Xem mã kết nối", "showConnectionInfo")
      .addItem("③ Kiểm tra thiết lập", "showHealthCheck")
      .addToUi();
  } catch (err) {
    // No UI context (e.g. triggered headlessly) - nothing to add a menu to.
  }
}

// The one function to run after pasting this file. Safe to run again: it only
// creates what's missing and only seeds a tab that is completely empty.
function setupEverything() {
  var result = actionSetup_({ seed: "1" });
  var token = getOrCreateToken_();

  var lines = [];
  lines.push(result.created.length ? "Đã tạo tab: " + result.created.join(", ") : "Các tab đã có sẵn.");
  if (result.repaired.length) lines.push("Đã sửa dòng tiêu đề: " + result.repaired.join(", ") + ".");
  if (result.seeded && result.seeded.categories) {
    lines.push("Đã nạp " + result.seeded.accounts + " tài khoản và " + result.seeded.categories + " danh mục mẫu.");
  }
  lines.push("");
  lines.push("MÃ KẾT NỐI (APP_TOKEN) của bạn:");
  lines.push(token);
  lines.push("");
  lines.push("Tiếp theo: Triển khai > Bản triển khai mới > loại \"Ứng dụng web\",");
  lines.push("chạy với tư cách \"Tôi\", quyền truy cập \"Bất kỳ ai có đường liên kết\".");
  lines.push("Rồi dán URL đó cùng mã trên vào trang web.");

  alert_("Thiết lập xong", lines.join("\n"));
  return { token: token, setup: result };
}

function showConnectionInfo() {
  alert_("Mã kết nối", "APP_TOKEN của bạn:\n\n" + getOrCreateToken_() +
    "\n\nPhiên bản mã đang chạy: " + VERSION +
    "\nMúi giờ bảng tính: " + getTimeZone_() +
    "\nNgày bắt đầu kỳ: " + getPeriodStartDay_());
}

function showHealthCheck() {
  var check = actionHealthCheck_({});
  var lines = check.checks.map(function (c) {
    return (c.ok ? "✓ " : "✗ ") + c.label + (c.detail ? " — " + c.detail : "");
  });
  alert_(check.ok ? "Mọi thứ ổn" : "Có mục cần xử lý", lines.join("\n"));
}

function alert_(title, message) {
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    Logger.log(title + "\n" + message); // no UI context - fall back to the log
  }
}

// Generates and stores a token on first use rather than making the user
// invent one and paste it into Script Properties by hand. A mistyped or
// missing APP_TOKEN was otherwise the first thing to break, with a "Sai token"
// error that doesn't say which side is wrong.
function getOrCreateToken_() {
  var properties = PropertiesService.getScriptProperties();
  var token = properties.getProperty("APP_TOKEN");
  if (token) return token;

  var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 - these get misread
  var generated = "";
  for (var i = 0; i < 12; i++) {
    generated += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    if (i === 3 || i === 7) generated += "-";
  }
  properties.setProperty("APP_TOKEN", generated);
  return generated;
}

// Reads the SPREADSHEET's timezone, not the script project's. The script
// project timezone lives in appsscript.json, which can't be set from code and
// which nobody remembers to change - and getting it wrong shifts every date by
// a day. The spreadsheet's own timezone can be set programmatically, so
// setupEverything pins it and everything here reads from there.
function getTimeZone_() {
  try {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    if (tz) return tz;
  } catch (err) {
    // fall through
  }
  return "Asia/Ho_Chi_Minh";
}

function nowString_() {
  return Utilities.formatDate(new Date(), getTimeZone_(), "yyyy-MM-dd HH:mm:ss");
}

// Reports exactly what is and isn't configured, so a problem names itself
// instead of surfacing as a generic failure three screens later.
function actionHealthCheck_(params) {
  var checks = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ALL_TABS.forEach(function (tab) {
    var sheet = ss.getSheetByName(tab.name);
    checks.push({
      key: "tab_" + tab.name,
      label: "Tab " + tab.name,
      ok: !!sheet,
      detail: sheet ? "" : "chưa có — chạy Thiết lập bảng tính",
    });
  });

  var accounts = rowsOfOptional_(SHEET_ACCOUNTS, ACCOUNTS_HEADER);
  checks.push({
    key: "accounts", label: "Tài khoản", ok: accounts.length > 0,
    detail: accounts.length ? accounts.length + " tài khoản" : "chưa có tài khoản nào",
  });

  var categories = rowsOfOptional_(SHEET_CATEGORIES, CATEGORIES_HEADER);
  checks.push({
    key: "categories", label: "Danh mục", ok: categories.length > 0,
    detail: categories.length ? categories.length + " danh mục" : "chưa có danh mục nào",
  });
  checks.push({
    key: "transfer_category", label: "Danh mục chuyển khoản",
    ok: categories.some(function (c) { return c.kind === "transfer"; }),
    detail: "cần 1 danh mục kind=transfer để ghi chuyển khoản nội bộ",
  });
  checks.push({
    key: "necessity", label: "Đã phân loại thiết yếu/tùy chọn",
    ok: categories.some(function (c) { return c.necessity === "essential"; }),
    detail: "nuôi các chỉ số rủi ro",
  });
  checks.push({
    key: "timezone", label: "Múi giờ bảng tính", ok: true, detail: getTimeZone_(),
  });
  checks.push({
    key: "gemini", label: "Gemini API key",
    ok: !!PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY"),
    detail: "tùy chọn — chỉ ảnh hưởng phần nhận xét AI",
  });

  return {
    version: VERSION,
    ok: checks.every(function (c) { return c.ok; }),
    checks: checks,
  };
}

// ------------------------------------------------------------------ routing

function doGet(e) {
  return handle_(e, "GET");
}

function doPost(e) {
  return handle_(e, "POST");
}

function handle_(e, method) {
  try {
    var params = method === "GET"
      ? (e.parameter || {})
      : JSON.parse((e.postData && e.postData.contents) || "{}");
    checkToken_(params.token);

    // Read-only actions run directly; anything that writes takes the script
    // lock first so two tabs (or a double-tapped save button) can't race two
    // appends into the same row.
    var readActions = {
      bootstrap: actionBootstrap_,
      get_forecast: actionGetForecast_,
      get_ai_summary: actionGetAiSummary_,
      get_ai_advice: actionGetAiAdvice_,
      export_csv: actionExportCsv_,
      health_check: actionHealthCheck_,
    };
    var writeActions = {
      setup: actionSetup_,
      add_account: actionAddAccount_,
      update_account: actionUpdateAccount_,
      add_category: actionAddCategory_,
      add_transaction: actionAddTransaction_,
      update_transaction: actionUpdateTransaction_,
      delete_transaction: actionDeleteTransaction_,
      add_transfer: actionAddTransfer_,
      set_period_budget: actionSetPeriodBudget_,
      delete_period_budget: actionDeletePeriodBudget_,
      add_goal: actionAddGoal_,
      deactivate_goal: actionDeactivateGoal_,
      add_recurring: actionAddRecurring_,
      deactivate_recurring: actionDeactivateRecurring_,
      add_rule: actionAddRule_,
      delete_rule: actionDeleteRule_,
    };

    var action = params.action;
    var result;
    if (readActions[action]) {
      result = readActions[action](params);
    } else if (writeActions[action]) {
      result = withLock_(function () { return writeActions[action](params); });
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
  if (!expected) throw new Error("Chua dat APP_TOKEN trong Script Properties.");
  if (token !== expected) throw new Error("Sai token.");
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------- sheet infra

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('Khong tim thay tab "' + name + '". Vao Cai dat > "Tao cac tab con thieu" de tao.');
  }
  return sheet;
}

// Like getSheet_, but returns null instead of throwing when a tab is missing.
// Used everywhere bootstrap reads an optional tab, so a Sheet created by an
// older version still loads (that feature just reads as empty) instead of
// every page load throwing and the whole app going dark. Write actions use
// the hard-throwing getSheet_ so actually USING a missing feature gives a
// clear error rather than silently doing nothing.
function getSheetOptional_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function sheetRowsAsObjects_(sheet, header) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var obj = {};
    for (var c = 0; c < header.length; c++) obj[header[c]] = values[i][c];
    // Skip fully-blank trailing rows (Sheets sometimes reports a longer
    // lastRow than there is real data).
    if (obj.id !== "" && obj.id !== null && obj.id !== undefined) rows.push(obj);
  }
  return rows;
}

function rowsOfOptional_(name, header) {
  var sheet = getSheetOptional_(name);
  return sheet ? sheetRowsAsObjects_(sheet, header) : [];
}

function nextId_(sheet, header) {
  var rows = sheetRowsAsObjects_(sheet, header);
  var max = 0;
  for (var i = 0; i < rows.length; i++) max = Math.max(max, Number(rows[i].id) || 0);
  return max + 1;
}

function findRowIndexById_(sheet, header, id) {
  var rows = sheetRowsAsObjects_(sheet, header);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].id) === Number(id)) return i + 2; // +2: header row + 1-indexing
  }
  return -1;
}

function setCell_(sheet, header, rowIndex, columnName, value) {
  sheet.getRange(rowIndex, header.indexOf(columnName) + 1).setValue(value);
}

// --------------------------------------------------------------- setup/seed

// Header rows have only ever grown (Categories went 4 -> 6 columns in v2),
// never been reordered, so rewriting the full header row is safe on an
// existing tab and is what upgrades an older Sheet in place.
function ensureHeader_(sheet, header) {
  var current = sheet.getLastRow() >= 1
    ? sheet.getRange(1, 1, 1, header.length).getValues()[0]
    : [];
  for (var i = 0; i < header.length; i++) {
    if (String(current[i] === undefined || current[i] === null ? "" : current[i]).trim() !== header[i]) {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      return true;
    }
  }
  return false;
}

// True when the Sheet isn't ready to be read yet: a tab is missing, or the
// category tree has never been seeded.
function needsSetup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < ALL_TABS.length; i++) {
    if (!ss.getSheetByName(ALL_TABS[i].name)) return true;
  }
  return sheetRowsAsObjects_(ss.getSheetByName(SHEET_CATEGORIES), CATEGORIES_HEADER).length === 0;
}

function actionSetup_(params) {
  params = params || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Pin the spreadsheet timezone here rather than asking the user to set the
  // script project's - see getTimeZone_ for why that distinction matters.
  try {
    if (ss.getSpreadsheetTimeZone() !== "Asia/Ho_Chi_Minh") {
      ss.setSpreadsheetTimeZone("Asia/Ho_Chi_Minh");
    }
  } catch (err) {
    // Not fatal: getTimeZone_ falls back to the same value anyway.
  }

  var created = [];
  var repaired = [];
  for (var i = 0; i < ALL_TABS.length; i++) {
    var tab = ALL_TABS[i];
    var sheet = ss.getSheetByName(tab.name);
    if (!sheet) {
      sheet = ss.insertSheet(tab.name);
      created.push(tab.name);
    }
    if (ensureHeader_(sheet, tab.header) && created.indexOf(tab.name) === -1) {
      repaired.push(tab.name);
    }
    formatSheet_(sheet, tab.header);
  }

  // Apps Script puts a "Sheet1" in every new spreadsheet. Leaving it there is
  // harmless but makes the tab bar confusing on a fresh setup.
  try {
    var leftover = ss.getSheetByName("Sheet1") || ss.getSheetByName("Trang tính1");
    if (leftover && leftover.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(leftover);
  } catch (err) {
    // Never let cosmetic cleanup fail the setup.
  }

  var seeded = truthy_(params.seed) ? seedDefaults_() : null;
  return { version: VERSION, created: created, repaired: repaired, seeded: seeded };
}

// Cosmetic only, and every call is individually guarded: the Sheet is also a
// place the user reads and edits by hand, so a frozen bold header and a
// thousands-separated amount column are worth setting - but none of it is
// worth failing setup over if an API call is unavailable.
function formatSheet_(sheet, header) {
  try { sheet.setFrozenRows(1); } catch (err) { /* ignore */ }
  try { sheet.getRange(1, 1, 1, header.length).setFontWeight("bold"); } catch (err) { /* ignore */ }
  try {
    var amountColumn = header.indexOf("amount") + 1;
    if (amountColumn > 0) sheet.getRange(2, amountColumn, 5000, 1).setNumberFormat("#,##0");
    var balanceColumn = header.indexOf("balance") + 1;
    if (balanceColumn > 0) sheet.getRange(2, balanceColumn, 5000, 1).setNumberFormat("#,##0");
    var targetColumn = header.indexOf("target_amount") + 1;
    if (targetColumn > 0) sheet.getRange(2, targetColumn, 5000, 1).setNumberFormat("#,##0");
  } catch (err) { /* ignore */ }
}

// Default accounts and the category tree, kept in step with the main app's
// seed_data.py so both versions classify spending the same way. Only runs
// when the tab is empty, so it can never duplicate a user's real data.
var SEED_ACCOUNTS = [
  ["Ngan hang", "bank"],
  ["Vi dien tu", "ewallet"],
  ["Tien mat", "cash"],
  ["The tin dung", "credit_card"],
];

// [name, necessity, stability, [children: [name, necessity, stability]]]
var SEED_EXPENSE_TREE = [
  ["Nhà ở", "essential", "fixed", [
    ["Tiền phòng/thuê nhà", "essential", "fixed"],
    ["Điện nước", "essential", "fixed"],
    ["Internet/Wifi", "essential", "fixed"],
  ]],
  ["Ăn uống", "essential", "variable", [
    ["Ăn ngoài", "essential", "variable"],
    ["Đi chợ/Nấu ăn", "essential", "variable"],
    ["Cà phê/Trà sữa", "optional", "variable"],
  ]],
  ["Di chuyển", "essential", "variable", [
    ["Xăng xe", "essential", "variable"],
    ["Grab/Taxi/Xe buýt", "essential", "variable"],
    ["Gửi xe", "essential", "variable"],
    ["Sửa xe", "essential", "variable"],
  ]],
  ["Học tập", "essential", "variable", [
    ["Học phí", "essential", "fixed"],
    ["Sách/Tài liệu", "essential", "variable"],
    ["Khóa học thêm", "optional", "variable"],
  ]],
  ["Sức khỏe", "essential", "variable", [
    ["Khám bệnh/Thuốc", "essential", "variable"],
    ["Bảo hiểm", "essential", "fixed"],
  ]],
  ["Bản thân & Giải trí", "optional", "variable", [
    ["Quần áo/Làm đẹp", "optional", "variable"],
    ["Giải trí/Xem phim", "optional", "variable"],
    ["Đăng ký dịch vụ", "optional", "fixed"],
    ["Du lịch", "optional", "variable"],
  ]],
  ["Mối quan hệ", "optional", "variable", [
    ["Hẹn hò/Bạn bè", "optional", "variable"],
    ["Quà tặng", "optional", "variable"],
    ["Hiếu hỉ", "optional", "variable"],
  ]],
  ["Gia đình", "essential", "variable", [
    ["Chuyển khoản cho gia đình", "essential", "variable"],
    ["Quà cho gia đình", "optional", "variable"],
  ]],
  ["Tài chính cá nhân", "essential", "fixed", [
    ["Trả nợ/Trả góp", "essential", "fixed"],
    ["Tiết kiệm/Đầu tư", "essential", "fixed"],
  ]],
  ["Khác", "optional", "variable", []],
];

var SEED_INCOME_CATEGORIES = ["Lương/Dạy học", "Trợ cấp gia đình", "Học bổng", "Thu nhập khác"];
var SEED_TRANSFER_CATEGORIES = ["Chuyển khoản nội bộ"];

function seedDefaults_() {
  var result = { accounts: 0, categories: 0 };

  var accountSheet = getSheet_(SHEET_ACCOUNTS);
  if (sheetRowsAsObjects_(accountSheet, ACCOUNTS_HEADER).length === 0) {
    for (var a = 0; a < SEED_ACCOUNTS.length; a++) {
      accountSheet.appendRow([a + 1, SEED_ACCOUNTS[a][0], SEED_ACCOUNTS[a][1], 0, true]);
      result.accounts++;
    }
  }

  var categorySheet = getSheet_(SHEET_CATEGORIES);
  if (sheetRowsAsObjects_(categorySheet, CATEGORIES_HEADER).length === 0) {
    var id = 1;
    for (var p = 0; p < SEED_EXPENSE_TREE.length; p++) {
      var parent = SEED_EXPENSE_TREE[p];
      var parentId = id++;
      categorySheet.appendRow([parentId, parent[0], "expense", "", parent[1], parent[2]]);
      result.categories++;
      var children = parent[3];
      for (var c = 0; c < children.length; c++) {
        categorySheet.appendRow([id++, children[c][0], "expense", parentId, children[c][1], children[c][2]]);
        result.categories++;
      }
    }
    for (var i = 0; i < SEED_INCOME_CATEGORIES.length; i++) {
      categorySheet.appendRow([id++, SEED_INCOME_CATEGORIES[i], "income", "", "", "variable"]);
      result.categories++;
    }
    for (var t = 0; t < SEED_TRANSFER_CATEGORIES.length; t++) {
      categorySheet.appendRow([id++, SEED_TRANSFER_CATEGORIES[t], "transfer", "", "", ""]);
      result.categories++;
    }
  }

  return result;
}

// ------------------------------------------------- amount parsing (mirrors
// transaction.parse_amount_vnd). Ported by hand rather than shared - this is
// a separate JS runtime with no code-sharing mechanism with the Python app.
// Keep the two in sync if either changes.

var AMOUNT_UNIT_MULTIPLIERS = {
  k: 1e3, nghin: 1e3, "nghìn": 1e3,
  tr: 1e6, trieu: 1e6, "triệu": 1e6,
  ty: 1e9, "tỷ": 1e9,
};

function parseAmountVnd_(raw) {
  if (raw === null || raw === undefined) throw new Error("Chua nhap so tien.");
  var text = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  if (!text) throw new Error("Chua nhap so tien.");

  // "2tr5" == 2,5 trieu - a real everyday Vietnamese shorthand where the
  // digit after the unit means tenths, not a separate number.
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

// ------------------------------------------------------ period math (mirrors
// period.py). A "ky tai chinh" is a configurable cycle - by default the 15th
// of one month through the 14th of the next. Dates travel as plain
// {year, month, day} objects through the public API, converting to a real
// Date only inside the day-arithmetic helpers, which avoids timezone
// off-by-one surprises.

function pad2_(n) { return n < 10 ? "0" + n : String(n); }

function daysInMonth_(year, month) {
  return new Date(year, month, 0).getDate(); // day 0 of next month = last day of this one
}

function toJsDate_(d) { return new Date(d.year, d.month - 1, d.day); }
function fromJsDate_(jsDate) { return { year: jsDate.getFullYear(), month: jsDate.getMonth() + 1, day: jsDate.getDate() }; }

function addDays_(d, days) {
  var jsDate = toJsDate_(d);
  jsDate.setDate(jsDate.getDate() + days);
  return fromJsDate_(jsDate);
}

function daysBetween_(a, b) {
  var msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toJsDate_(b).getTime() - toJsDate_(a).getTime()) / msPerDay);
}

// Same day-clamping convention as period.py's _add_months: shifting a date
// with day=31 into a 30-day month clamps to that month's last day.
function addMonths_(year, month, day, months) {
  var monthIndex = (month - 1) + months;
  var newYear = year + Math.floor(monthIndex / 12);
  var newMonth = ((monthIndex % 12) + 12) % 12 + 1;
  var newDay = Math.min(day, daysInMonth_(newYear, newMonth));
  return { year: newYear, month: newMonth, day: newDay };
}

function parseDateOnly_(dateStr) {
  var parts = String(dateStr).slice(0, 10).split("-");
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

function dateToStr_(d) { return d.year + "-" + pad2_(d.month) + "-" + pad2_(d.day); }

function getPeriodStartDay_() {
  var v = PropertiesService.getScriptProperties().getProperty("PERIOD_START_DAY");
  var n = v ? Number(v) : 15;
  return (n >= 1 && n <= 31) ? n : 15;
}

function todayParts_() {
  return parseDateOnly_(Utilities.formatDate(new Date(), getTimeZone_(), "yyyy-MM-dd"));
}

function periodBounds_(d, startDay) {
  var clampedThisMonth = Math.min(startDay, daysInMonth_(d.year, d.month));
  var periodStart;
  if (d.day >= clampedThisMonth) {
    periodStart = { year: d.year, month: d.month, day: clampedThisMonth };
  } else {
    var prevMonthFirst = addMonths_(d.year, d.month, 1, -1);
    var clampedPrevMonth = Math.min(startDay, daysInMonth_(prevMonthFirst.year, prevMonthFirst.month));
    periodStart = { year: prevMonthFirst.year, month: prevMonthFirst.month, day: clampedPrevMonth };
  }
  var periodEnd = addDays_(addMonths_(periodStart.year, periodStart.month, periodStart.day, 1), -1);
  return { start: periodStart, end: periodEnd };
}

// A period id looks like a calendar month ("YYYY-MM", the period's start
// date) so it sorts the same way, but it IS NOT one once startDay != 1 -
// never compare it against a raw date's first 7 characters.
function periodIdFor_(d, startDay) {
  var bounds = periodBounds_(d, startDay);
  return bounds.start.year + "-" + pad2_(bounds.start.month);
}

function periodBoundsForId_(periodIdStr, startDay) {
  var parts = String(periodIdStr).split("-");
  var year = Number(parts[0]), month = Number(parts[1]);
  var clampedDay = Math.min(startDay, daysInMonth_(year, month));
  var periodStart = { year: year, month: month, day: clampedDay };
  var periodEnd = addDays_(addMonths_(periodStart.year, periodStart.month, periodStart.day, 1), -1);
  return { start: periodStart, end: periodEnd };
}

function shiftPeriodId_(periodIdStr, n, startDay) {
  var bounds = periodBoundsForId_(periodIdStr, startDay);
  var shifted = addMonths_(bounds.start.year, bounds.start.month, bounds.start.day, n);
  return shifted.year + "-" + pad2_(shifted.month);
}

function currentPeriodId_(startDay, asOf) {
  return periodIdFor_(asOf, startDay);
}

function recentPeriodIds_(currentId, n, startDay, includeCurrent) {
  var ids = [];
  var startOffset = includeCurrent ? 0 : -1;
  for (var offset = startOffset; offset > startOffset - n; offset--) {
    ids.push(shiftPeriodId_(currentId, offset, startDay));
  }
  ids.reverse();
  return ids;
}

function periodsBetween_(periodIdA, periodIdB) {
  var a = String(periodIdA).split("-"), b = String(periodIdB).split("-");
  return (Number(b[0]) - Number(a[0])) * 12 + (Number(b[1]) - Number(a[1]));
}

function daysElapsedAndRemaining_(d, startDay) {
  var bounds = periodBounds_(d, startDay);
  var total = daysBetween_(bounds.start, bounds.end) + 1;
  var elapsed = daysBetween_(bounds.start, d) + 1;
  return { total: total, elapsed: elapsed, remaining: total - elapsed, periodStart: bounds.start, periodEnd: bounds.end };
}

// ------------------------------------------------------- shared read helpers

function truthy_(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

// Treats the literal text "FALSE" as inactive too, not just a real boolean -
// a Sheets cell holding the typed word rather than a checkbox is a real and
// easy-to-hit case.
function isActive_(value) {
  return value !== false && value !== "FALSE" && value !== "false" && value !== "" && value !== 0;
}

// Credit cards are the one account type treated as non-liquid. A
// simplification vs. the main app's explicit is_liquid column, kept out of
// the sheet schema to avoid one more column to fill in per account.
function isLiquidAccountType_(type) { return type !== "credit_card"; }

function getTransferCategoryIds_(categories) {
  var ids = {};
  categories.forEach(function (c) { if (c.kind === "transfer") ids[c.id] = true; });
  return ids;
}

function getLiquidBalance_(accounts) {
  var total = 0;
  accounts.forEach(function (a) {
    if (isActive_(a.is_active) && isLiquidAccountType_(a.type)) total += Number(a.balance) || 0;
  });
  return total;
}

// Every active account, liquid or not. Deliberately different from
// getLiquidBalance_: this answers "how much do I own", that one answers "how
// much can I actually spend right now". Never use net worth for a safety
// metric - counting illiquid assets would make runway look safer than it is.
function getNetWorth_(accounts) {
  var total = 0;
  accounts.forEach(function (a) {
    if (isActive_(a.is_active)) total += Number(a.balance) || 0;
  });
  return total;
}

function indexById_(rows) {
  var map = {};
  rows.forEach(function (r) { map[r.id] = r; });
  return map;
}

function inPeriod_(dateParts, bounds) {
  return daysBetween_(bounds.start, dateParts) >= 0 && daysBetween_(dateParts, bounds.end) >= 0;
}

// ----------------------------------------------------- recurring generation
// Mirrors transaction.generate_due_recurring: for every active recurring row
// whose next_due has arrived, create the transaction (adjusting the account
// balance) and advance next_due. Idempotent within a day - once nothing is
// due, re-running is a no-op - so it's safe to call on every bootstrap.

function advanceDueDate_(dueStr, frequency) {
  var d = parseDateOnly_(dueStr);
  if (frequency === "weekly") return dateToStr_(addDays_(d, 7));
  var months = frequency === "quarterly" ? 3 : (frequency === "yearly" ? 12 : 1);
  return dateToStr_(addMonths_(d.year, d.month, d.day, months));
}

function generateDueRecurring_(asOf) {
  var sheet = getSheetOptional_(SHEET_RECURRING);
  if (!sheet) return { generated: 0 };
  var rows = sheetRowsAsObjects_(sheet, RECURRING_HEADER);
  if (rows.length === 0) return { generated: 0 };

  var txSheet = getSheet_(SHEET_TRANSACTIONS);
  var nextTxId = nextId_(txSheet, TRANSACTIONS_HEADER);
  var todayStr = dateToStr_(asOf);
  var balanceDeltas = {};
  var generated = 0;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!isActive_(r.is_active) || !r.next_due) continue;
    var due = String(r.next_due).slice(0, 10);
    var amount = Number(r.amount) || 0;
    var direction = r.direction === "in" ? "in" : "out";
    var fired = 0;
    while (due <= todayStr && fired < RECURRING_CATCHUP_LIMIT) {
      txSheet.appendRow([
        nextTxId++, due + " 00:00:00", amount, direction,
        r.account_id, r.category_id || "", r.name || "Khoản định kỳ", "recurring",
      ]);
      balanceDeltas[r.account_id] = (balanceDeltas[r.account_id] || 0) + (direction === "in" ? amount : -amount);
      due = advanceDueDate_(due, r.frequency);
      fired++;
      generated++;
    }
    if (fired > 0) setCell_(sheet, RECURRING_HEADER, i + 2, "next_due", due);
  }

  for (var accountId in balanceDeltas) {
    if (balanceDeltas.hasOwnProperty(accountId)) applyBalanceDelta_(accountId, balanceDeltas[accountId]);
  }
  return { generated: generated };
}

// ------------------------------------------- auto-categorisation (mirrors
// transaction.apply_matching_rule): case-insensitive substring match of a
// rule's pattern against the description, highest priority tried first.

function findMatchingRule_(rules, description) {
  if (!description) return null;
  var text = String(description).toLowerCase();
  var sorted = rules.slice().sort(function (a, b) {
    return (Number(b.priority) || 0) - (Number(a.priority) || 0);
  });
  for (var i = 0; i < sorted.length; i++) {
    var pattern = String(sorted[i].pattern || "").toLowerCase().trim();
    if (pattern && text.indexOf(pattern) !== -1) return sorted[i];
  }
  return null;
}

// Returns the category id a blank-category transaction should get, bumping
// the winning rule's hit_count as a side effect.
function resolveCategoryFromRules_(description) {
  var sheet = getSheetOptional_(SHEET_RULES);
  if (!sheet) return "";
  var rules = sheetRowsAsObjects_(sheet, RULES_HEADER);
  var match = findMatchingRule_(rules, description);
  if (!match) return "";
  for (var i = 0; i < rules.length; i++) {
    if (Number(rules[i].id) === Number(match.id)) {
      setCell_(sheet, RULES_HEADER, i + 2, "hit_count", (Number(rules[i].hit_count) || 0) + 1);
      break;
    }
  }
  return match.category_id;
}

// -------------------------------------------------- risk metrics (risk.py)

// Average essential-category spend per period, over the last N *completed*
// periods that actually have essential spending. A period with none is
// skipped, not counted as 0 - a genuinely empty period dragging this average
// down would understate a safety-critical number.
function getAverageEssentialExpensePerPeriod_(transactions, categories, startDay, asOf) {
  var essentialIds = {};
  categories.forEach(function (c) { if (c.necessity === "essential") essentialIds[c.id] = true; });

  var currentId = currentPeriodId_(startDay, asOf);
  var totals = {};
  transactions.forEach(function (t) {
    if (t.direction !== "out" || !essentialIds[t.category_id]) return;
    var pid = periodIdFor_(parseDateOnly_(t.occurred_at), startDay);
    if (pid >= currentId) return; // the current period is still open
    totals[pid] = (totals[pid] || 0) + Number(t.amount);
  });

  var ids = Object.keys(totals).sort().reverse().slice(0, ESSENTIAL_LOOKBACK_PERIODS);
  if (ids.length === 0) return null;
  var sum = 0;
  ids.forEach(function (pid) { sum += totals[pid]; });
  return sum / ids.length;
}

function runwayMonths_(liquidBalance, essentialExpense) {
  if (!essentialExpense) return { months: null, level: null };
  var months = liquidBalance / essentialExpense;
  var level;
  if (months < RUNWAY_DANGER_MONTHS) level = "nguy_hiem";
  else if (months < RUNWAY_FRAGILE_MONTHS) level = "mong_manh";
  else if (months < RUNWAY_OK_MONTHS) level = "on";
  else level = "vung";
  return { months: months, level: level };
}

// Average daily 'out' spend over the trailing N days. `excludeRecurring`
// distinguishes the two versions the main app keeps separate:
//   - true  -> risk.get_average_daily_variable_spend, feeding the short-term
//              forecast, which subtracts recurring commitments separately and
//              would otherwise double-count them.
//   - false -> risk.get_average_daily_total_spend, feeding "survival days",
//              where bills genuinely should count.
function getAverageDailySpend_(transactions, transferCategoryIds, asOf, days, excludeRecurring) {
  var startDate = addDays_(asOf, -days);
  var total = 0;
  transactions.forEach(function (t) {
    if (t.direction !== "out" || transferCategoryIds[t.category_id]) return;
    if (excludeRecurring && t.source === "recurring") return;
    var d = parseDateOnly_(t.occurred_at);
    if (daysBetween_(startDate, d) > 0 && daysBetween_(d, asOf) >= 0) total += Number(t.amount);
  });
  return total / days;
}

// Recurring commitments still ahead of us this period. Only counts due dates
// strictly after today - anything due today or earlier has already been
// turned into a real transaction by generateDueRecurring_.
function getRemainingRecurringThisPeriod_(recurring, asOf, periodEnd) {
  var todayStr = dateToStr_(asOf);
  var endStr = dateToStr_(periodEnd);
  var total = 0;
  recurring.forEach(function (r) {
    if (!isActive_(r.is_active) || r.direction === "in" || !r.next_due) return;
    var due = String(r.next_due).slice(0, 10);
    if (due > todayStr && due <= endStr) total += Number(r.amount) || 0;
  });
  return total;
}

function shortTermForecast_(liquidBalance, dailySpend, daysRemaining, remainingRecurring) {
  var projectedSpend = Math.round(dailySpend * daysRemaining);
  var forecastBalance = liquidBalance - projectedSpend - remainingRecurring;
  return {
    forecastBalance: forecastBalance,
    projectedSpend: projectedSpend,
    remainingRecurring: remainingRecurring,
    atRisk: forecastBalance < 0,
  };
}

// How many days the liquid balance lasts at the recent all-in daily burn.
function getSurvivalDays_(liquidBalance, dailyTotalSpend) {
  if (!dailyTotalSpend || dailyTotalSpend <= 0) return null;
  return liquidBalance / dailyTotalSpend;
}

// Income and expense per completed period, oldest-first, skipping periods
// with no transactions at all. The shared basis for the savings-rate trend,
// income stability, and the baseline flow used by the forecast.
function getPeriodFlows_(transactions, transferCategoryIds, startDay, asOf, limit) {
  var currentId = currentPeriodId_(startDay, asOf);
  var income = {}, expense = {}, seen = {};
  transactions.forEach(function (t) {
    if (transferCategoryIds[t.category_id]) return;
    var pid = periodIdFor_(parseDateOnly_(t.occurred_at), startDay);
    if (pid >= currentId) return;
    seen[pid] = true;
    if (t.direction === "in") income[pid] = (income[pid] || 0) + Number(t.amount);
    else expense[pid] = (expense[pid] || 0) + Number(t.amount);
  });
  var ids = Object.keys(seen).sort().reverse().slice(0, limit).reverse();
  return ids.map(function (pid) {
    return { period_id: pid, income: income[pid] || 0, expense: expense[pid] || 0 };
  });
}

// Savings rate per completed period plus a direction of travel. Rate, not
// absolute amount saved, is what personal-finance literature treats as
// predictive - and it's the only metric here that shows change over time
// rather than a point-in-time snapshot.
function getSavingsRateTrend_(flows) {
  var periods = flows.map(function (f) {
    return {
      period_id: f.period_id,
      income: f.income,
      expense: f.expense,
      rate: f.income > 0 ? (f.income - f.expense) / f.income * 100 : null,
    };
  });
  var withRate = periods.filter(function (p) { return p.rate !== null; });
  var trend = null;
  if (withRate.length >= 2) {
    var diff = withRate[withRate.length - 1].rate - withRate[0].rate;
    trend = diff > 2 ? "improving" : (diff < -2 ? "declining" : "stable");
  }
  return { periods: periods, trend: trend };
}

// Coefficient of variation (stdev / mean) of income across completed
// periods. Lower means steadier income.
function getIncomeStability_(flows) {
  var incomes = flows.map(function (f) { return f.income; }).filter(function (v) { return v > 0; });
  if (incomes.length < 2) return { has_data: false, cv_pct: null };
  var mean = incomes.reduce(function (a, b) { return a + b; }, 0) / incomes.length;
  if (mean <= 0) return { has_data: false, cv_pct: null };
  var variance = incomes.reduce(function (acc, v) { return acc + Math.pow(v - mean, 2); }, 0) / incomes.length;
  return { has_data: true, cv_pct: Math.sqrt(variance) / mean * 100 };
}

// Share of income committed to 'fixed'-stability categories over the last N
// completed periods. High rigidity means little room to cut when income
// drops.
function getFinancialRigidity_(transactions, categories, transferCategoryIds, startDay, asOf) {
  var fixedIds = {};
  categories.forEach(function (c) { if (c.stability === "fixed" && c.kind === "expense") fixedIds[c.id] = true; });
  var currentId = currentPeriodId_(startDay, asOf);
  var ids = recentPeriodIds_(currentId, RIGIDITY_LOOKBACK_PERIODS, startDay, false);
  var inWindow = {};
  ids.forEach(function (pid) { inWindow[pid] = true; });

  var fixedSpend = 0, income = 0;
  transactions.forEach(function (t) {
    var pid = periodIdFor_(parseDateOnly_(t.occurred_at), startDay);
    if (!inWindow[pid]) return;
    if (t.direction === "in") {
      if (!transferCategoryIds[t.category_id]) income += Number(t.amount);
    } else if (fixedIds[t.category_id]) {
      fixedSpend += Number(t.amount);
    }
  });
  if (income <= 0) return { has_data: false, pct: null };
  return { has_data: true, pct: fixedSpend / income * 100, fixed_spend: fixedSpend, income: income };
}

// Budget spent so far vs. time elapsed, both as a percentage of the period.
// A ratio above 1 means spending is running ahead of the calendar.
function getBurnRateVsElapsed_(budgetStatuses, daysInfo) {
  if (budgetStatuses.length === 0) return { has_data: false, ratio: null };
  var budgeted = 0, spent = 0;
  budgetStatuses.forEach(function (s) { budgeted += s.amount; spent += s.spent; });
  if (budgeted <= 0) return { has_data: false, ratio: null };
  var pctSpent = spent / budgeted * 100;
  var pctElapsed = daysInfo.elapsed / daysInfo.total * 100;
  return {
    has_data: true,
    pct_spent: pctSpent,
    pct_elapsed: pctElapsed,
    ratio: pctElapsed > 0 ? pctSpent / pctElapsed : null,
  };
}

// Savings rate for the elapsed part of the CURRENT period - a "how's today
// going" complement to the completed-periods-only trend above.
function getCurrentPeriodSavingsRate_(transactions, transferCategoryIds, bounds) {
  var income = 0, expense = 0;
  transactions.forEach(function (t) {
    if (transferCategoryIds[t.category_id]) return;
    if (!inPeriod_(parseDateOnly_(t.occurred_at), bounds)) return;
    if (t.direction === "in") income += Number(t.amount);
    else expense += Number(t.amount);
  });
  return {
    has_data: income > 0,
    income: income,
    expense: expense,
    rate: income > 0 ? (income - expense) / income * 100 : null,
  };
}

// Which top-level category is eating the biggest share of this period's
// spend. Children roll up into their parent, so "Cà phê" counts toward
// "Ăn uống" rather than fragmenting the picture.
function getSpendingConcentration_(transactions, categories, bounds) {
  var byId = indexById_(categories);
  var totals = {}, grand = 0;
  transactions.forEach(function (t) {
    if (t.direction !== "out") return;
    var category = byId[t.category_id];
    if (!category || category.kind === "transfer") return;
    if (!inPeriod_(parseDateOnly_(t.occurred_at), bounds)) return;
    var rootId = category.parent_id ? category.parent_id : category.id;
    var amount = Number(t.amount);
    totals[rootId] = (totals[rootId] || 0) + amount;
    grand += amount;
  });
  if (grand <= 0) return { has_data: false };
  var topId = null, topAmount = 0;
  for (var id in totals) {
    if (totals.hasOwnProperty(id) && totals[id] > topAmount) { topAmount = totals[id]; topId = id; }
  }
  var breakdown = Object.keys(totals).map(function (id) {
    return {
      category_name: (byId[id] || {}).name || "?",
      amount: totals[id],
      pct: totals[id] / grand * 100,
    };
  }).sort(function (a, b) { return b.amount - a.amount; });
  return {
    has_data: true,
    category_name: (byId[topId] || {}).name || "?",
    amount: topAmount,
    pct: topAmount / grand * 100,
    total: grand,
    breakdown: breakdown,
  };
}

// Essential / optional / income split for one period - the 50/30/20 rule
// from THIET-KE.md part 4.4. Transfers never appear here: a transfer
// category's necessity is always blank and neither bucket reads blanks.
function getBudgetBalance_(transactions, categories, bounds) {
  var byId = indexById_(categories);
  var essential = 0, optional = 0, unclassified = 0, income = 0;
  transactions.forEach(function (t) {
    if (!inPeriod_(parseDateOnly_(t.occurred_at), bounds)) return;
    var category = byId[t.category_id];
    if (category && category.kind === "transfer") return;
    if (t.direction === "in") { income += Number(t.amount); return; }
    var necessity = category ? category.necessity : "";
    if (necessity === "essential") essential += Number(t.amount);
    else if (necessity === "optional") optional += Number(t.amount);
    else unclassified += Number(t.amount);
  });
  return {
    has_data: income > 0,
    income: income,
    essential: essential,
    optional: optional,
    unclassified: unclassified,
    essential_pct: income > 0 ? essential / income * 100 : null,
    optional_pct: income > 0 ? optional / income * 100 : null,
    saving_pct: income > 0 ? (income - essential - optional - unclassified) / income * 100 : null,
  };
}

// Consecutive completed periods, most recent first, where no budgeted
// category went over. Stops at the first over-budget period OR the first
// period with no budgets set at all - an unbudgeted period isn't a win.
function getBudgetStreak_(periodBudgetRows, transactions, categories, startDay, asOf) {
  var currentId = currentPeriodId_(startDay, asOf);
  var streak = 0;
  for (var offset = -1; offset >= -24; offset--) {
    var pid = shiftPeriodId_(currentId, offset, startDay);
    var statuses = getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, pid, startDay);
    if (statuses.length === 0) break;
    var anyOver = statuses.some(function (s) { return s.over_budget; });
    if (anyOver) break;
    streak++;
  }
  return streak;
}

// Composite headline. Starts from runway's level - the app's most stable,
// longest-horizon signal - and only ever DOWNGRADES, by up to one level each
// for two more urgent signals. Never upgrading past what runway itself says
// is deliberate: when signals disagree this app errs toward the more
// cautious one, per THIET-KE.md 7.2's loss-aversion framing.
function getHealthScore_(runway, forecast, burnRate) {
  if (!runway.level) return { level: null, has_data: false, downgraded_reasons: [] };
  var index = HEALTH_LEVELS.indexOf(runway.level);
  var reasons = [];
  if (forecast.atRisk) {
    index = Math.max(0, index - 1);
    reasons.push("Dự báo số dư cuối kỳ có thể âm.");
  }
  if (burnRate.has_data && burnRate.ratio > BURN_RATE_DANGER_RATIO) {
    index = Math.max(0, index - 1);
    reasons.push("Đang tiêu nhanh hơn nhịp thời gian của kỳ.");
  }
  return { level: HEALTH_LEVELS[index], has_data: true, downgraded_reasons: reasons };
}

function getActiveAlerts_(liquidBalance, essentialExpense, runway, forecast, budgetStatuses) {
  var alerts = [];
  if (forecast.atRisk) {
    alerts.push({
      code: "short_term_forecast_negative", level: "danger",
      message: "Dự báo cuối kỳ có thể âm quỹ: " + formatVndServer_(Math.round(forecast.forecastBalance)) + " đ. Cân nhắc giảm chi tiêu.",
    });
  }
  if (essentialExpense !== null && liquidBalance < essentialExpense) {
    alerts.push({
      code: "liquidity_insufficient", level: "warning",
      message: "Tài sản lỏng hiện không đủ trang trải 1 kỳ chi phí thiết yếu.",
    });
  }
  if (runway.level === "nguy_hiem") {
    alerts.push({
      code: "runway_danger", level: "danger",
      message: "Nền móng tài chính nguy hiểm: chỉ đủ sống " + runway.months.toFixed(1) + " kỳ nếu mất thu nhập.",
    });
  } else if (runway.level === "mong_manh") {
    alerts.push({
      code: "runway_fragile", level: "warning",
      message: "Nền móng tài chính mong manh: đủ sống " + runway.months.toFixed(1) + " kỳ nếu mất thu nhập.",
    });
  }
  var over = budgetStatuses.filter(function (s) { return s.over_budget; });
  if (over.length > 0) {
    alerts.push({
      code: "budget_exceeded", level: "warning",
      message: "Đã vượt ngân sách: " + over.map(function (s) { return s.category_name; }).join(", ") + ".",
    });
  }
  return alerts;
}

function formatVndServer_(n) {
  var sign = n < 0 ? "-" : "";
  var digits = String(Math.abs(Math.round(n)));
  var out = "";
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return sign + out;
}

// ------------------------------------------------------------ period budgets

function getActualSpendInPeriod_(transactions, categoryId, periodId, startDay) {
  var bounds = periodBoundsForId_(periodId, startDay);
  var total = 0;
  transactions.forEach(function (t) {
    if (t.direction !== "out" || String(t.category_id) !== String(categoryId)) return;
    if (inPeriod_(parseDateOnly_(t.occurred_at), bounds)) total += Number(t.amount);
  });
  return total;
}

function getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, periodId, startDay) {
  var nameById = {};
  categories.forEach(function (c) { nameById[c.id] = c.name; });

  var statuses = [];
  periodBudgetRows.filter(function (b) { return String(b.period_id) === String(periodId); }).forEach(function (b) {
    var spent = getActualSpendInPeriod_(transactions, b.category_id, periodId, startDay);
    var amount = Number(b.amount);
    statuses.push({
      id: b.id,
      category_id: b.category_id,
      category_name: nameById[b.category_id] || "?",
      amount: amount,
      spent: spent,
      remaining: amount - spent,
      pct_used: amount > 0 ? (spent / amount * 100) : 0,
      over_budget: spent > amount,
    });
  });
  return statuses.sort(function (a, b) { return b.pct_used - a.pct_used; });
}

// Formula-based suggestion, mirroring risk.suggest_period_budget_amounts:
//   'fixed'    -> copy the previous period's budget verbatim (falls back to
//                 the variable rule when there is no previous budget yet)
//   'variable' -> average actual spend over the last 3 completed periods,
//                 counting a zero-spend period AS zero rather than skipping
//                 it. That's the opposite convention from the essential-
//                 expense average above, deliberately: for "how much do I
//                 typically spend here", an unused category genuinely should
//                 pull the suggestion down; for a safety metric, a missing
//                 data point pulling the number down is the failure mode.
function suggestPeriodBudgetAmounts_(periodBudgetRows, transactions, categories, periodId, startDay) {
  var previousId = shiftPeriodId_(periodId, -1, startDay);
  var lookback = [];
  for (var i = 1; i <= 3; i++) lookback.push(shiftPeriodId_(periodId, -i, startDay));

  var suggestions = {};
  categories.forEach(function (c) {
    if (c.kind !== "expense" || !c.stability) return;

    if (c.stability === "fixed") {
      var previous = periodBudgetRows.filter(function (b) {
        return String(b.category_id) === String(c.id) && String(b.period_id) === String(previousId);
      })[0];
      if (previous) {
        suggestions[c.id] = Number(previous.amount);
        return;
      }
    }
    var total = 0;
    lookback.forEach(function (pid) {
      total += getActualSpendInPeriod_(transactions, c.id, pid, startDay);
    });
    var average = Math.round(total / lookback.length);
    if (average > 0) suggestions[c.id] = average;
  });
  return suggestions;
}

function actionSetPeriodBudget_(params) {
  var categoryId = Number(params.category_id);
  var periodId = String(params.period_id || "");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  if (!periodId.match(/^\d{4}-\d{2}$/)) throw new Error("period_id khong hop le.");

  var sheet = getSheet_(SHEET_PERIOD_BUDGETS);
  var rows = sheetRowsAsObjects_(sheet, PERIOD_BUDGETS_HEADER);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].category_id) === categoryId && String(rows[i].period_id) === periodId) {
      setCell_(sheet, PERIOD_BUDGETS_HEADER, i + 2, "amount", amount);
      return { id: rows[i].id, updated: true };
    }
  }
  var id = nextId_(sheet, PERIOD_BUDGETS_HEADER);
  sheet.appendRow([id, categoryId, periodId, amount]);
  return { id: id, updated: false };
}

function actionDeletePeriodBudget_(params) {
  var sheet = getSheet_(SHEET_PERIOD_BUDGETS);
  var rowIndex = findRowIndexById_(sheet, PERIOD_BUDGETS_HEADER, Number(params.id));
  if (rowIndex === -1) return { deleted: false };
  sheet.deleteRow(rowIndex);
  return { deleted: true };
}

// -------------------------------------------------------------------- goals

// Progress is read live from the linked account's balance rather than a
// separately-tracked running total. Deliberate trade-off, same as the main
// app: two goals pointing at one account each show that account's full
// balance, but there's no second source of truth that can drift from the
// account's real balance.
function getGoalProgress_(goal, accounts, startDay, asOf) {
  var account = accounts.filter(function (a) { return Number(a.id) === Number(goal.account_id); })[0];
  var current = account ? Number(account.balance) : 0;
  var target = Number(goal.target_amount);

  var progressPct = target > 0 ? Math.min(current / target * 100, 100) : 0;
  var remainingAmount = Math.max(target - current, 0);

  var deadline = parseDateOnly_(goal.deadline);
  var created = parseDateOnly_(goal.created_at);
  var currentId = periodIdFor_(asOf, startDay);
  var deadlineId = periodIdFor_(deadline, startDay);
  var createdId = periodIdFor_(created, startDay);

  var periodsRemaining = Math.max(periodsBetween_(currentId, deadlineId) + 1, 0);
  var requiredPerPeriod = periodsRemaining > 0 ? Math.round(remainingAmount / periodsRemaining) : remainingAmount;

  // A plain LINEAR schedule comparison, explicitly not a forecast: expected
  // progress is just periods-elapsed over periods-total.
  var totalPeriods = Math.max(periodsBetween_(createdId, deadlineId) + 1, 1);
  var elapsedPeriods = Math.min(Math.max(periodsBetween_(createdId, currentId) + 1, 0), totalPeriods);
  var expectedPct = elapsedPeriods / totalPeriods * 100;

  var isOverdue = daysBetween_(asOf, deadline) < 0 && remainingAmount > 0;
  return {
    progress_pct: progressPct,
    expected_pct: expectedPct,
    remaining_amount: remainingAmount,
    periods_remaining: periodsRemaining,
    required_per_period: requiredPerPeriod,
    is_overdue: isOverdue,
    // is_overdue takes precedence so a goal is never flagged both ways.
    is_off_track: !isOverdue && (progressPct + 5 < expectedPct),
  };
}

function suggestEmergencyFundTarget_(essentialExpense) {
  if (!essentialExpense) return null;
  return Math.round(essentialExpense * EMERGENCY_FUND_PERIODS);
}

function actionAddGoal_(params) {
  var name = String(params.name || "").trim();
  if (!name) throw new Error("Ten muc tieu khong duoc de trong.");
  var targetAmount = parseAmountVnd_(params.target_amount);
  if (targetAmount <= 0) throw new Error("So tien dich phai lon hon 0.");
  var deadline = String(params.deadline || "");
  if (!deadline.match(/^\d{4}-\d{2}-\d{2}$/)) throw new Error("Han chot khong hop le.");
  var accountId = Number(params.account_id);
  findActiveAccountRowIndex_(accountId);

  var sheet = getSheet_(SHEET_GOALS);
  var id = nextId_(sheet, GOALS_HEADER);
  sheet.appendRow([id, name, params.goal_type || "custom", targetAmount, deadline, accountId, dateToStr_(todayParts_()), true]);
  return { id: id };
}

// "An" (hide), not delete: is_active = 0 keeps the row and its history, it
// just stops appearing anywhere, since every read already filters on it.
function actionDeactivateGoal_(params) {
  var sheet = getSheet_(SHEET_GOALS);
  var rowIndex = findRowIndexById_(sheet, GOALS_HEADER, Number(params.id));
  if (rowIndex === -1) return { deactivated: false };
  setCell_(sheet, GOALS_HEADER, rowIndex, "is_active", false);
  return { deactivated: true };
}

// ---------------------------------------------------------------- recurring

function actionAddRecurring_(params) {
  var name = String(params.name || "").trim();
  if (!name) throw new Error("Ten khoan dinh ky khong duoc de trong.");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  var direction = params.direction === "in" ? "in" : "out";
  var frequency = ["weekly", "monthly", "quarterly", "yearly"].indexOf(params.frequency) !== -1 ? params.frequency : "monthly";
  var nextDue = String(params.next_due || "");
  if (!nextDue.match(/^\d{4}-\d{2}-\d{2}$/)) throw new Error("Ngay den han khong hop le.");
  var accountId = Number(params.account_id);
  findActiveAccountRowIndex_(accountId);

  var sheet = getSheet_(SHEET_RECURRING);
  var id = nextId_(sheet, RECURRING_HEADER);
  sheet.appendRow([id, name, amount, direction, accountId, params.category_id || "", frequency, nextDue, true]);
  return { id: id };
}

function actionDeactivateRecurring_(params) {
  var sheet = getSheet_(SHEET_RECURRING);
  var rowIndex = findRowIndexById_(sheet, RECURRING_HEADER, Number(params.id));
  if (rowIndex === -1) return { deactivated: false };
  setCell_(sheet, RECURRING_HEADER, rowIndex, "is_active", false);
  return { deactivated: true };
}

// -------------------------------------------------------------------- rules

function actionAddRule_(params) {
  var pattern = String(params.pattern || "").trim();
  if (!pattern) throw new Error("Tu khoa khong duoc de trong.");
  var categoryId = Number(params.category_id);
  if (!categoryId) throw new Error("Phai chon danh muc cho luat.");
  var sheet = getSheet_(SHEET_RULES);
  var id = nextId_(sheet, RULES_HEADER);
  sheet.appendRow([id, pattern, categoryId, Number(params.priority) || 0, 0, params.created_from || "user"]);
  return { id: id };
}

function actionDeleteRule_(params) {
  var sheet = getSheet_(SHEET_RULES);
  var rowIndex = findRowIndexById_(sheet, RULES_HEADER, Number(params.id));
  if (rowIndex === -1) return { deleted: false };
  sheet.deleteRow(rowIndex);
  return { deleted: true };
}

// ----------------------------------------------------------------- forecast

// The SIMPLE trajectory (risk.project_simple_trajectory): continue the recent
// average income/expense flat and chain each period's ending balance into the
// next one's start. Deliberately not Moc 4's richer model - no recurring
// modelling beyond what's already in the historical average, no seasonality,
// no macro context, nothing persisted.
function actionGetForecast_(params) {
  var periodsAhead = Math.max(1, Math.min(Number(params.periods_ahead) || 6, 12));
  var startDay = getPeriodStartDay_();
  var asOf = todayParts_();

  var accounts = sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER);
  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  var transferCategoryIds = getTransferCategoryIds_(categories);

  var flows = getPeriodFlows_(transactions, transferCategoryIds, startDay, asOf, BASELINE_FLOW_LOOKBACK_PERIODS);
  var avgIncome = 0, avgExpense = 0;
  if (flows.length > 0) {
    flows.forEach(function (f) { avgIncome += f.income; avgExpense += f.expense; });
    avgIncome /= flows.length;
    avgExpense /= flows.length;
  }

  // Active goals add a real, separate outflow the historical average doesn't
  // contain. Known simplification: a goal keeps contributing past its own
  // deadline inside the window, since stopping it at the right offset needs
  // per-goal period bookkeeping this function doesn't do.
  var goalContribution = 0;
  if (truthy_(params.include_goals)) {
    var goals = rowsOfOptional_(SHEET_GOALS, GOALS_HEADER).filter(function (g) { return isActive_(g.is_active); });
    goals.forEach(function (g) {
      var progress = getGoalProgress_(g, accounts, startDay, asOf);
      if (!progress.is_overdue) goalContribution += progress.required_per_period;
    });
  }

  var balance = getLiquidBalance_(accounts);
  var currentId = currentPeriodId_(startDay, asOf);
  var periods = [];
  for (var i = 0; i < periodsAhead; i++) {
    balance = balance + avgIncome - avgExpense - goalContribution;
    periods.push({
      period_id: shiftPeriodId_(currentId, i + 1, startDay),
      projected_balance: Math.round(balance),
    });
  }
  return {
    periods: periods,
    avg_income: Math.round(avgIncome),
    avg_expense: Math.round(avgExpense),
    goal_contribution: Math.round(goalContribution),
    periods_of_history: flows.length,
  };
}

// ---------------------------------------------------------------- bootstrap

// Everything the page needs in a single round trip. Apps Script Web App
// calls cost roughly a second each, so one fat call beats eight small ones.
function actionBootstrap_(params) {
  params = params || {}; // callable with no args from the Apps Script editor

  // Self-heal on first load: a brand-new (or older) Sheet gets its tabs built
  // here, so "paste the code, deploy, open the page" really is all there is -
  // no separate setup step to forget. Seeding only fires when Categories is
  // completely empty, so this can never duplicate real data. Bootstrap is a
  // read action and isn't lock-wrapped, hence the lock + re-check: two tabs
  // opening at once must not both try to build the same sheets.
  var autoSetup = null;
  if (needsSetup_()) {
    autoSetup = withLock_(function () {
      return needsSetup_() ? actionSetup_({ seed: "1" }) : null;
    });
  }

  var startDay = getPeriodStartDay_();
  var asOf = todayParts_();

  // Runs before anything is read, so today's due bills are already real
  // transactions by the time every metric below is computed.
  var recurringResult = generateDueRecurring_(asOf);

  var accountsAll = sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER);
  var accounts = accountsAll.filter(function (a) { return isActive_(a.is_active); });
  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  transactions.sort(function (a, b) { return (String(a.occurred_at) < String(b.occurred_at)) ? 1 : -1; });

  var periodBudgetRows = rowsOfOptional_(SHEET_PERIOD_BUDGETS, PERIOD_BUDGETS_HEADER);
  var goalsAll = rowsOfOptional_(SHEET_GOALS, GOALS_HEADER);
  var recurringAll = rowsOfOptional_(SHEET_RECURRING, RECURRING_HEADER);
  var rules = rowsOfOptional_(SHEET_RULES, RULES_HEADER);

  var accountById = indexById_(accountsAll);
  var categoryById = indexById_(categories);
  var transferCategoryIds = getTransferCategoryIds_(categories);

  var periodId = String(params.period_id || "").match(/^\d{4}-\d{2}$/)
    ? String(params.period_id)
    : currentPeriodId_(startDay, asOf);
  var currentId = currentPeriodId_(startDay, asOf);
  var daysInfo = daysElapsedAndRemaining_(asOf, startDay);
  var currentBounds = { start: daysInfo.periodStart, end: daysInfo.periodEnd };

  var recent = transactions.slice(0, RECENT_TRANSACTION_LIMIT).map(function (t) {
    return {
      id: t.id,
      occurred_at: t.occurred_at,
      amount: Number(t.amount),
      direction: t.direction,
      account_id: t.account_id,
      account_name: (accountById[t.account_id] || {}).name || "?",
      category_id: t.category_id,
      category_name: (categoryById[t.category_id] || {}).name || "",
      is_transfer: !!transferCategoryIds[t.category_id],
      description: t.description,
      source: t.source,
    };
  });

  // --- Risk metrics ---
  var liquidBalance = getLiquidBalance_(accounts);
  var netWorth = getNetWorth_(accounts);
  var essentialExpense = getAverageEssentialExpensePerPeriod_(transactions, categories, startDay, asOf);
  var runway = runwayMonths_(liquidBalance, essentialExpense);
  var dailyVariableSpend = getAverageDailySpend_(transactions, transferCategoryIds, asOf, SPEND_LOOKBACK_DAYS, true);
  var dailyTotalSpend = getAverageDailySpend_(transactions, transferCategoryIds, asOf, SPEND_LOOKBACK_DAYS, false);
  var remainingRecurring = getRemainingRecurringThisPeriod_(recurringAll, asOf, daysInfo.periodEnd);
  var forecast = shortTermForecast_(liquidBalance, dailyVariableSpend, daysInfo.remaining, remainingRecurring);

  var budgetStatuses = getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, periodId, startDay);
  var currentBudgetStatuses = periodId === currentId
    ? budgetStatuses
    : getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, currentId, startDay);
  var burnRate = getBurnRateVsElapsed_(currentBudgetStatuses, daysInfo);
  var health = getHealthScore_(runway, forecast, burnRate);

  var flows = getPeriodFlows_(transactions, transferCategoryIds, startDay, asOf, TREND_LOOKBACK_PERIODS);
  var savingsTrend = getSavingsRateTrend_(flows);

  var alerts = getActiveAlerts_(liquidBalance, essentialExpense, runway, forecast, currentBudgetStatuses);

  var goals = goalsAll.filter(function (g) { return isActive_(g.is_active); }).map(function (g) {
    var progress = getGoalProgress_(g, accountsAll, startDay, asOf);
    var account = accountById[g.account_id] || {};
    return {
      id: g.id, name: g.name, goal_type: g.goal_type,
      target_amount: Number(g.target_amount), deadline: g.deadline,
      account_id: g.account_id, account_name: account.name || "?",
      current_balance: Number(account.balance) || 0,
      progress_pct: progress.progress_pct,
      expected_pct: progress.expected_pct,
      remaining_amount: progress.remaining_amount,
      periods_remaining: progress.periods_remaining,
      required_per_period: progress.required_per_period,
      is_overdue: progress.is_overdue,
      is_off_track: progress.is_off_track,
    };
  });

  var recurring = recurringAll.filter(function (r) { return isActive_(r.is_active); }).map(function (r) {
    return {
      id: r.id, name: r.name, amount: Number(r.amount), direction: r.direction,
      account_name: (accountById[r.account_id] || {}).name || "?",
      category_name: (categoryById[r.category_id] || {}).name || "",
      frequency: r.frequency, next_due: String(r.next_due).slice(0, 10),
    };
  });

  return {
    version: VERSION,
    auto_setup: autoSetup,
    period: {
      id: periodId,
      current_id: currentId,
      is_current: periodId === currentId,
      start: dateToStr_(daysInfo.periodStart),
      end: dateToStr_(daysInfo.periodEnd),
      start_day: startDay,
      days_total: daysInfo.total,
      days_elapsed: daysInfo.elapsed,
      days_remaining: daysInfo.remaining,
      today: dateToStr_(asOf),
    },
    accounts: accounts.map(function (a) {
      return {
        id: a.id, name: a.name, type: a.type,
        balance: Number(a.balance) || 0,
        is_liquid: isLiquidAccountType_(a.type),
      };
    }),
    categories: categories,
    transactions: recent,
    transaction_count: transactions.length,
    recurring: recurring,
    rules: rules.map(function (r) {
      return {
        id: r.id, pattern: r.pattern, category_id: r.category_id,
        category_name: (categoryById[r.category_id] || {}).name || "?",
        priority: Number(r.priority) || 0, hit_count: Number(r.hit_count) || 0,
        created_from: r.created_from,
      };
    }),
    alerts: alerts,
    health: {
      level: health.level,
      has_data: health.has_data,
      downgraded_reasons: health.downgraded_reasons,
      runway_months: runway.months,
      runway_level: runway.level,
    },
    money: {
      liquid_balance: liquidBalance,
      net_worth: netWorth,
      essential_expense_per_period: essentialExpense,
      forecast_balance: forecast.forecastBalance,
      projected_spend: forecast.projectedSpend,
      remaining_recurring: forecast.remainingRecurring,
      at_risk: forecast.atRisk,
      daily_variable_spend: Math.round(dailyVariableSpend),
      daily_total_spend: Math.round(dailyTotalSpend),
      survival_days: getSurvivalDays_(liquidBalance, dailyTotalSpend),
      emergency_fund_target: suggestEmergencyFundTarget_(essentialExpense),
    },
    metrics: {
      burn_rate: burnRate,
      rigidity: getFinancialRigidity_(transactions, categories, transferCategoryIds, startDay, asOf),
      current_savings_rate: getCurrentPeriodSavingsRate_(transactions, transferCategoryIds, currentBounds),
      concentration: getSpendingConcentration_(transactions, categories, currentBounds),
      income_stability: getIncomeStability_(flows),
      budget_streak: getBudgetStreak_(periodBudgetRows, transactions, categories, startDay, asOf),
      balance_50_30_20: getBudgetBalance_(transactions, categories, currentBounds),
      savings_trend: savingsTrend,
    },
    budget_statuses: budgetStatuses,
    budget_suggestions: suggestPeriodBudgetAmounts_(periodBudgetRows, transactions, categories, periodId, startDay),
    goals: goals,
    recurring_generated: recurringResult.generated,
  };
}

// ----------------------------------------------------------- write: accounts

function actionAddAccount_(params) {
  var name = String(params.name || "").trim();
  if (!name) throw new Error("Ten tai khoan khong duoc de trong.");
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var id = nextId_(sheet, ACCOUNTS_HEADER);
  var opening = params.balance ? parseAmountVnd_(params.balance) : 0;
  sheet.appendRow([id, name, params.type || "bank", opening, true]);
  return { id: id };
}

// Renaming, hiding, or correcting an account's balance to match reality. A
// balance correction is written directly rather than as an adjusting
// transaction - this is the "I mistyped the opening balance" escape hatch,
// not a way to record income.
function actionUpdateAccount_(params) {
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var rowIndex = findRowIndexById_(sheet, ACCOUNTS_HEADER, Number(params.id));
  if (rowIndex === -1) throw new Error("Khong tim thay tai khoan.");
  if (params.name !== undefined && String(params.name).trim()) {
    setCell_(sheet, ACCOUNTS_HEADER, rowIndex, "name", String(params.name).trim());
  }
  if (params.type !== undefined && params.type) {
    setCell_(sheet, ACCOUNTS_HEADER, rowIndex, "type", params.type);
  }
  if (params.balance !== undefined && String(params.balance) !== "") {
    setCell_(sheet, ACCOUNTS_HEADER, rowIndex, "balance", parseAmountVnd_(params.balance));
  }
  if (params.is_active !== undefined) {
    setCell_(sheet, ACCOUNTS_HEADER, rowIndex, "is_active", truthy_(params.is_active));
  }
  return { updated: true };
}

function actionAddCategory_(params) {
  var name = String(params.name || "").trim();
  var kind = params.kind;
  if (!name) throw new Error("Ten danh muc khong duoc de trong.");
  if (["expense", "income", "transfer"].indexOf(kind) === -1) throw new Error("Loai danh muc khong hop le.");
  var necessity = (params.necessity === "essential" || params.necessity === "optional") ? params.necessity : "";
  var stability = (params.stability === "fixed" || params.stability === "variable") ? params.stability : "";
  var sheet = getSheet_(SHEET_CATEGORIES);
  var id = nextId_(sheet, CATEGORIES_HEADER);
  sheet.appendRow([id, name, kind, params.parent_id || "", necessity, stability]);
  return { id: id };
}

// ------------------------------------------------------- write: transactions

// Validates an account exists AND is active, returning its sheet row index.
// Deliberately called BEFORE any appendRow: Sheets has no rollback, so
// validating inside the balance update (as an earlier version did) left a
// phantom transaction row pointing nowhere - and for a transfer specifically,
// a valid source account could already have money deducted before an invalid
// destination was caught, with no matching credit anywhere.
function findActiveAccountRowIndex_(accountId) {
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var rows = sheetRowsAsObjects_(sheet, ACCOUNTS_HEADER);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].id) === Number(accountId) && isActive_(rows[i].is_active)) return i + 2;
  }
  throw new Error("Tai khoan khong hop le.");
}

function applyBalanceDelta_(accountId, delta) {
  if (!delta) return;
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var rowIndex = findActiveAccountRowIndex_(accountId);
  var balanceCol = ACCOUNTS_HEADER.indexOf("balance") + 1;
  var cell = sheet.getRange(rowIndex, balanceCol);
  cell.setValue((Number(cell.getValue()) || 0) + delta);
}

function resolveOccurredAt_(raw) {
  var text = String(raw || "").trim();
  if (!text) return nowString_();
  if (text.match(/^\d{4}-\d{2}-\d{2}$/)) return text + " 12:00:00";
  if (text.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) return text;
  throw new Error("Ngay giao dich khong hop le.");
}

function actionAddTransaction_(params) {
  var direction = params.direction;
  if (direction !== "in" && direction !== "out") throw new Error("Loai giao dich khong hop le.");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  var accountId = Number(params.account_id);
  findActiveAccountRowIndex_(accountId); // throws before any write if invalid
  var occurredAt = resolveOccurredAt_(params.occurred_at);
  var description = params.description || "";

  // Same contract as transaction.resolve_category: an explicitly chosen
  // category always wins; the rules engine only fills in a blank one.
  var categoryId = params.category_id || "";
  var autoCategorised = false;
  if (!categoryId) {
    categoryId = resolveCategoryFromRules_(description);
    autoCategorised = !!categoryId;
  }

  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var id = nextId_(sheet, TRANSACTIONS_HEADER);
  sheet.appendRow([id, occurredAt, amount, direction, accountId, categoryId, description, "manual"]);
  applyBalanceDelta_(accountId, direction === "in" ? amount : -amount);
  return { id: id, amount: amount, category_id: categoryId, auto_categorised: autoCategorised };
}

// Reverses the old row's effect on the old account, then applies the new
// one - so changing amount, direction, or account all stay consistent.
function actionUpdateTransaction_(params) {
  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var rowIndex = findRowIndexById_(sheet, TRANSACTIONS_HEADER, Number(params.id));
  if (rowIndex === -1) throw new Error("Khong tim thay giao dich.");

  var old = sheet.getRange(rowIndex, 1, 1, TRANSACTIONS_HEADER.length).getValues()[0];
  var oldAmount = Number(old[TRANSACTIONS_HEADER.indexOf("amount")]);
  var oldDirection = old[TRANSACTIONS_HEADER.indexOf("direction")];
  var oldAccountId = old[TRANSACTIONS_HEADER.indexOf("account_id")];

  var direction = (params.direction === "in" || params.direction === "out") ? params.direction : oldDirection;
  var amount = (params.amount !== undefined && String(params.amount) !== "") ? parseAmountVnd_(params.amount) : oldAmount;
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  var accountId = params.account_id ? Number(params.account_id) : Number(oldAccountId);
  findActiveAccountRowIndex_(accountId); // validate before any write

  setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "amount", amount);
  setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "direction", direction);
  setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "account_id", accountId);
  if (params.category_id !== undefined) {
    setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "category_id", params.category_id || "");
  }
  if (params.description !== undefined) {
    setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "description", params.description);
  }
  if (params.occurred_at !== undefined && String(params.occurred_at).trim()) {
    setCell_(sheet, TRANSACTIONS_HEADER, rowIndex, "occurred_at", resolveOccurredAt_(params.occurred_at));
  }

  applyBalanceDelta_(oldAccountId, oldDirection === "in" ? -oldAmount : oldAmount);
  applyBalanceDelta_(accountId, direction === "in" ? amount : -amount);
  return { updated: true, amount: amount };
}

function actionDeleteTransaction_(params) {
  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var rowIndex = findRowIndexById_(sheet, TRANSACTIONS_HEADER, Number(params.id));
  if (rowIndex === -1) return { deleted: false };

  var row = sheet.getRange(rowIndex, 1, 1, TRANSACTIONS_HEADER.length).getValues()[0];
  var amount = Number(row[TRANSACTIONS_HEADER.indexOf("amount")]);
  var direction = row[TRANSACTIONS_HEADER.indexOf("direction")];
  var accountId = row[TRANSACTIONS_HEADER.indexOf("account_id")];

  sheet.deleteRow(rowIndex);
  applyBalanceDelta_(accountId, direction === "in" ? -amount : amount);
  return { deleted: true };
}

// A transfer is two ordinary linked transactions - an 'out' leg and an 'in'
// leg sharing a timestamp and a transfer-kind category - rather than a new
// table or a third direction value. Every income/expense sum in this file
// excludes transfer categories, so moving money between your own accounts
// never inflates real income or expense.
function actionAddTransfer_(params) {
  var fromId = Number(params.from_account_id);
  var toId = Number(params.to_account_id);
  if (fromId === toId) throw new Error("Tai khoan nguon va dich phai khac nhau.");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  findActiveAccountRowIndex_(fromId);
  findActiveAccountRowIndex_(toId);

  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transferCategory = categories.filter(function (c) { return c.kind === "transfer"; })[0];
  if (!transferCategory) throw new Error("Chua co danh muc Chuyen khoan - them 1 danh muc loai transfer.");

  var sheet = getSheet_(SHEET_TRANSACTIONS);
  var occurredAt = resolveOccurredAt_(params.occurred_at);
  var description = params.description || "";

  var outId = nextId_(sheet, TRANSACTIONS_HEADER);
  sheet.appendRow([outId, occurredAt, amount, "out", fromId, transferCategory.id, description, "manual"]);
  sheet.appendRow([outId + 1, occurredAt, amount, "in", toId, transferCategory.id, description, "manual"]);

  applyBalanceDelta_(fromId, -amount);
  applyBalanceDelta_(toId, amount);
  return { out_id: outId, in_id: outId + 1 };
}

// ------------------------------------------------------------------- export

// Every transaction, oldest-first, as CSV text. The client adds a UTF-8 BOM
// and turns this into a download - without the BOM, Excel on Windows renders
// Vietnamese diacritics as mojibake.
function actionExportCsv_(params) {
  var accounts = indexById_(sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER));
  var categories = indexById_(sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER));
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  transactions.sort(function (a, b) { return String(a.occurred_at) < String(b.occurred_at) ? -1 : 1; });

  function cell(value) {
    var text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  var lines = ["occurred_at,amount,direction,account,category,description,source"];
  transactions.forEach(function (t) {
    lines.push([
      cell(t.occurred_at), cell(t.amount), cell(t.direction),
      cell((accounts[t.account_id] || {}).name || ""),
      cell((categories[t.category_id] || {}).name || ""),
      cell(t.description), cell(t.source),
    ].join(","));
  });
  return { csv: lines.join("\n"), rows: transactions.length };
}

// ----------------------------------------------------------------------- AI
//
// Same standing rule as the main app: the model never computes a number, it
// only interprets numbers already computed above in plain JavaScript. And the
// same graceful-degradation contract as services/ai_client.get_ai_suggestion -
// these never throw to the client, they return {available: false, reason}
// so the page simply hides the panel and everything else keeps working.

var GEMINI_MODEL = "gemini-flash-latest";

function callGemini_(prompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { available: false, reason: "no_key" };
  try {
    var response = UrlFetchApp.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + apiKey,
      {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        muteHttpExceptions: true,
      }
    );
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) return { available: false, reason: "network" };
    var parsed = JSON.parse(response.getContentText());
    var text = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content &&
      parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] &&
      parsed.candidates[0].content.parts[0].text;
    if (!text) return { available: false, reason: "invalid_response" };
    return { available: true, text: String(text).trim() };
  } catch (err) {
    return { available: false, reason: "network" };
  }
}

var AI_GROUND_RULES =
  "Bạn là trợ lý tài chính cá nhân, nói tiếng Việt, giọng điệu điềm tĩnh và cụ thể, không gây hoang mang. " +
  "Mọi con số dưới đây ĐÃ được tính sẵn chính xác bằng JavaScript. " +
  "TUYỆT ĐỐI không tự tính toán số mới, không bịa số không có trong dữ liệu, không đưa lời khuyên đầu tư cụ thể. " +
  "Nếu dữ liệu chưa đủ, hãy nói thẳng là chưa đủ dữ liệu. ";

function actionGetAiSummary_(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { available: false, reason: "no_key" };

  var boot = actionBootstrap_(params);

  // Nothing to interpret yet. Asking the model to comment on an empty ledger
  // burns a call and can only produce something vague or, worse, invented -
  // the one failure mode this app's AI rules exist to prevent.
  if (boot.transaction_count === 0) return { available: false, reason: "no_data" };

  var data = {
    hom_nay: boot.period.today,
    ky: boot.period.id,
    con_lai_trong_ky_ngay: boot.period.days_remaining,
    suc_khoe: boot.health.level,
    ly_do_bi_ha_bac: boot.health.downgraded_reasons,
    so_ky_du_tru: boot.health.runway_months,
    so_du_thanh_khoan: boot.money.liquid_balance,
    tong_tai_san: boot.money.net_worth,
    du_bao_cuoi_ky: boot.money.forecast_balance,
    so_ngay_cam_cu: boot.money.survival_days,
    canh_bao_dang_co: boot.alerts.map(function (a) { return a.message; }),
    ngan_sach_vuot_muc: boot.budget_statuses.filter(function (s) { return s.over_budget; }).map(function (s) { return s.category_name; }),
    danh_muc_ngon_tien_nhat: boot.metrics.concentration.has_data
      ? { ten: boot.metrics.concentration.category_name, phan_tram: Math.round(boot.metrics.concentration.pct) }
      : null,
    ty_le_tiet_kiem_ky_nay: boot.metrics.current_savings_rate.rate,
    xu_huong_tiet_kiem: boot.metrics.savings_trend.trend,
    muc_tieu_tong: boot.goals.length,
    muc_tieu_cham_tien_do: boot.goals.filter(function (g) { return g.is_off_track || g.is_overdue; }).map(function (g) { return g.name; }),
  };

  var prompt = AI_GROUND_RULES +
    "Viết 2-3 câu tóm tắt tình hình tài chính HÔM NAY của người dùng. " +
    "Nêu điều đáng chú ý nhất, và nếu hai dữ kiện có liên quan tới nhau (ví dụ một mục tiêu chậm tiến độ " +
    "cùng lúc với một danh mục vượt ngân sách) thì hãy nối chúng lại thay vì chỉ đọc lại từng con số. " +
    "Dữ liệu (JSON): " + JSON.stringify(data);

  var result = callGemini_(prompt);
  if (!result.available) return result;
  return { available: true, summary: result.text };
}

// Topic-based advice. `context` is a JSON string of numbers the client has
// already computed (the spending simulator runs entirely client-side), so
// this stays consistent with the never-compute rule.
function actionGetAiAdvice_(params) {
  var topic = String(params.topic || "");
  var context = String(params.context || "{}");
  var instruction;

  if (topic === "goals") {
    instruction = "Dưới đây là các mục tiêu tài chính của người dùng kèm số tiền còn thiếu, số kỳ còn lại " +
      "và số tiền cần dành mỗi kỳ. Hãy xếp thứ tự ưu tiên nên tập trung vào mục tiêu nào trước và giải thích ngắn gọn vì sao " +
      "(chỉ viện dẫn nguyên tắc tài chính cá nhân phổ biến khi thực sự liên quan, ví dụ quỹ khẩn cấp trước đầu tư). " +
      "Tối đa 4 câu.";
  } else if (topic === "simulation") {
    instruction = "Dưới đây là các kịch bản cho một khoản chi lớn người dùng đang cân nhắc (trả ngay, trả góp, hoãn lại), " +
      "kèm số dư dự báo và đèn tín hiệu xanh/vàng/đỏ đã tính sẵn. " +
      "Nêu ngắn gọn ưu và nhược của phương án đáng cân nhắc nhất, rồi đưa 1 khuyến nghị rõ ràng kèm lý do. Tối đa 5 câu.";
  } else if (topic === "budget") {
    instruction = "Dưới đây là ngân sách theo kỳ của người dùng và mức chi thực tế. " +
      "Nhận xét ngắn gọn ngân sách này có thực tế không so với lịch sử chi tiêu, và nên điều chỉnh danh mục nào. Tối đa 4 câu.";
  } else {
    return { available: false, reason: "invalid_response" };
  }

  var result = callGemini_(AI_GROUND_RULES + instruction + " Dữ liệu (JSON): " + context);
  if (!result.available) return result;
  return { available: true, advice: result.text };
}
