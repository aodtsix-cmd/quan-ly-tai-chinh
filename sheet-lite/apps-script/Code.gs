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
 * v2 (added after v1 shipped) folds in a slice of the main app's "hoach
 * dinh tuong lai" milestones, deliberately simplified for this smaller
 * runtime - see each section's own comment for what was cut and why:
 *   - Canh bao rui ro (risk alerts): liquidity/runway/short-term forecast,
 *     same formulas as risk.py, but short-term forecast has no recurring-
 *     transaction concept here, so it's spend-only (documented below).
 *   - Ngan sach theo ky (period budgets): manual amounts only, no formula
 *     suggestion (that needs 3-period spend history math this port keeps
 *     minimal).
 *   - Muc tieu tai chinh (goals): same linear-schedule progress math as
 *     risk.get_goal_progress.
 *   - Du bao dong tien (forecast): the SIMPLE version (risk.py's
 *     project_simple_trajectory - flat historical-average extrapolation),
 *     not the richer Moc 4 forecast (no recurring modeling, no
 *     seasonality, no macro-context - those need more infrastructure than
 *     is worth porting yet).
 *   - Tich hop AI: one Gemini call summarizing the numbers above, called
 *     directly from Apps Script via UrlFetchApp (no separate server
 *     needed - Apps Script itself plays that role here).
 *
 * ---- One-time setup ----
 * 1. Create a new Google Sheet. Create tabs named exactly:
 *    Accounts, Categories, Transactions, PeriodBudgets, Goals
 *    (see the *_HEADER constants below for each tab's header row).
 * 2. Extensions > Apps Script. Paste this whole file in as Code.gs.
 * 3. Project Settings > Script Properties:
 *    - APP_TOKEN (required) - your shared password, same idea as the main
 *      app's APP_PASSWORD.
 *    - PERIOD_START_DAY (optional, default 15) - which day of the month
 *      your "ky tai chinh" (financial period) starts on, same concept as
 *      the main app's app_settings.period_start_day.
 *    - GEMINI_API_KEY (optional) - only needed for the AI summary feature;
 *      everything else works without it. Free key at
 *      https://aistudio.google.com/apikey
 *    Also set Time zone to (GMT+07:00) Vietnam Time on this same page.
 * 4. Deploy > New deployment > type "Web app". Execute as "Me", who has
 *    access "Anyone with the link". Copy the deployment URL.
 * 5. Paste that URL and your APP_TOKEN into index.html's config prompt
 *    (asked once, then remembered in the browser via localStorage).
 */

var SHEET_ACCOUNTS = "Accounts";
var SHEET_CATEGORIES = "Categories";
var SHEET_TRANSACTIONS = "Transactions";
var SHEET_PERIOD_BUDGETS = "PeriodBudgets";
var SHEET_GOALS = "Goals";

var ACCOUNTS_HEADER = ["id", "name", "type", "balance", "is_active"];
// necessity: "essential" | "optional" | "" (blank = not read by risk math,
// same as main app's categories.necessity being nullable for non-expense
// kinds). stability: "fixed" | "variable" | "" - not read yet in v2, kept
// for schema parity with the main app so it doesn't need another
// migration if a later pass wants it (e.g. a financial-rigidity metric).
var CATEGORIES_HEADER = ["id", "name", "kind", "parent_id", "necessity", "stability"];
var TRANSACTIONS_HEADER = ["id", "occurred_at", "amount", "direction", "account_id", "category_id", "description", "source"];
var PERIOD_BUDGETS_HEADER = ["id", "category_id", "period_id", "amount"];
var GOALS_HEADER = ["id", "name", "goal_type", "target_amount", "deadline", "account_id", "created_at", "is_active"];

var SPEND_LOOKBACK_DAYS = 30;
var ESSENTIAL_LOOKBACK_PERIODS = 3;
var BASELINE_FLOW_LOOKBACK_PERIODS = 3;
var RUNWAY_DANGER_MONTHS = 1;
var RUNWAY_FRAGILE_MONTHS = 3;
var RUNWAY_OK_MONTHS = 6;

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
      result = actionBootstrap_(params);
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
    } else if (action === "set_period_budget") {
      result = withLock_(function () { return actionSetPeriodBudget_(params); });
    } else if (action === "add_goal") {
      result = withLock_(function () { return actionAddGoal_(params); });
    } else if (action === "deactivate_goal") {
      result = withLock_(function () { return actionDeactivateGoal_(params); });
    } else if (action === "get_forecast") {
      result = actionGetForecast_(params);
    } else if (action === "get_ai_summary") {
      result = actionGetAiSummary_(params);
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

// Like getSheet_, but returns null instead of throwing when the tab is
// missing - used for the tabs added in v2 (PeriodBudgets, Goals) so that a
// v1 user who deploys this newer Code.gs before adding those tabs still
// gets a working bootstrap (budgets/goals just read as empty) instead of
// the ENTIRE page breaking on every load. Explicit actions that need one of
// these tabs (set_period_budget, add_goal) still use getSheet_ directly, so
// trying to actually USE a v2 feature without the tab yet gives a clear
// error instead of silently doing nothing.
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

// ---------- Period math (mirrors period.py) ----------
//
// A "ky tai chinh" (financial period) is a configurable cycle - default
// the 15th of one month through the 14th of the next (PERIOD_START_DAY
// script property) - same concept as the main app's period.py, ported by
// hand (no code-sharing mechanism between this JS runtime and that Python
// module). Dates are handled as plain {year, month, day} objects rather
// than JS Date throughout the public API, converting to/from a real Date
// only inside the day-arithmetic helpers - avoids timezone-related
// off-by-one surprises when comparing dates.

function pad2_(n) { return n < 10 ? "0" + n : String(n); }

function daysInMonth_(year, month) {
  return new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
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
  var tz = Session.getScriptTimeZone();
  return parseDateOnly_(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"));
}

// (start, end) of the period containing `d`, both inclusive.
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

function periodIdFor_(d, startDay) {
  var bounds = periodBounds_(d, startDay);
  return bounds.start.year + "-" + pad2_(bounds.start.month);
}

function periodBoundsForId_(periodIdStr, startDay) {
  var parts = periodIdStr.split("-");
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

// Last n period ids, oldest-first, matching period.recent_period_ids_for.
function recentPeriodIds_(currentId, n, startDay, includeCurrent) {
  var ids = [];
  var startOffset = includeCurrent ? 0 : -1;
  for (var offset = startOffset; offset > startOffset - n; offset--) {
    ids.push(shiftPeriodId_(currentId, offset, startDay));
  }
  ids.reverse();
  return ids;
}

function daysElapsedAndRemaining_(d, startDay) {
  var bounds = periodBounds_(d, startDay);
  var total = daysBetween_(bounds.start, bounds.end) + 1;
  var elapsed = daysBetween_(bounds.start, d) + 1;
  return { total: total, elapsed: elapsed, remaining: total - elapsed, periodStart: bounds.start, periodEnd: bounds.end };
}

// ---------- Shared read helpers ----------

function isActive_(value) {
  return value !== false && value !== "FALSE" && value !== "false" && value !== "" && value !== 0;
}

// Credit cards are the one account type this app treats as non-liquid (a
// simplification vs. the main app's own explicit is_liquid column - kept
// out of the sheet schema to avoid one more column the user has to fill
// in by hand for every account).
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

// ---------- Risk / alerts (mirrors risk.py + alerts.py, simplified) ----------

// Average essential-category spend per period, over the last N *completed*
// periods that actually have essential spending - periods with none are
// skipped, not counted as 0 (same reasoning as risk.py: a genuinely-empty
// period dragging the average down would understate a safety number).
function getAverageEssentialExpensePerPeriod_(transactions, categories, startDay, asOf) {
  var essentialCategoryIds = {};
  categories.forEach(function (c) { if (c.necessity === "essential") essentialCategoryIds[c.id] = true; });

  var currentId = currentPeriodId_(startDay, asOf);
  var totalsByPeriod = {};
  transactions.forEach(function (t) {
    if (t.direction !== "out" || !essentialCategoryIds[t.category_id]) return;
    var pid = periodIdFor_(parseDateOnly_(t.occurred_at), startDay);
    if (pid >= currentId) return; // exclude the still-open current period
    totalsByPeriod[pid] = (totalsByPeriod[pid] || 0) + Number(t.amount);
  });

  var periodIds = Object.keys(totalsByPeriod).sort().reverse().slice(0, ESSENTIAL_LOOKBACK_PERIODS);
  if (periodIds.length === 0) return null;
  var sum = 0;
  periodIds.forEach(function (pid) { sum += totalsByPeriod[pid]; });
  return sum / periodIds.length;
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

// Average daily 'out' spend (transfers excluded) over the trailing N days -
// used for the short-term forecast below. Unlike risk.py's
// get_average_daily_variable_spend, there's no recurring-transaction
// concept in sheet-lite yet to exclude, so this is simply "all spending"
// (documented simplification, see this file's header comment).
function getAverageDailySpend_(transactions, transferCategoryIds, asOf, days) {
  var startDate = addDays_(asOf, -days);
  var total = 0;
  transactions.forEach(function (t) {
    if (t.direction !== "out" || transferCategoryIds[t.category_id]) return;
    var d = parseDateOnly_(t.occurred_at);
    if (daysBetween_(startDate, d) > 0 && daysBetween_(d, asOf) >= 0) total += Number(t.amount);
  });
  return total / days;
}

// Simplified vs. risk.short_term_forecast: no recurring commitments to
// subtract (sheet-lite has no Recurring tab yet), so this is liquid
// balance minus projected variable spend for the rest of the period only.
function shortTermForecast_(liquidBalance, dailySpend, daysRemaining) {
  var projectedSpend = Math.round(dailySpend * daysRemaining);
  var forecastBalance = liquidBalance - projectedSpend;
  return { forecastBalance: forecastBalance, projectedSpend: projectedSpend, atRisk: forecastBalance < 0 };
}

function getActiveAlerts_(liquidBalance, essentialExpense, runway, forecast) {
  var alerts = [];
  if (forecast.atRisk) {
    alerts.push({
      code: "short_term_forecast_negative", level: "danger",
      message: "Dự báo cuối kỳ có thể âm quỹ: " + Math.round(forecast.forecastBalance).toLocaleString("vi-VN") + " đ. Cân nhắc giảm chi tiêu.",
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
  return alerts;
}

// ---------- Period budgets (mirrors period_budgets + get_period_budget_status) ----------

function getActualSpendInPeriod_(transactions, categoryId, periodId, startDay) {
  var bounds = periodBoundsForId_(periodId, startDay);
  var total = 0;
  transactions.forEach(function (t) {
    if (t.direction !== "out" || String(t.category_id) !== String(categoryId)) return;
    var d = parseDateOnly_(t.occurred_at);
    if (daysBetween_(bounds.start, d) >= 0 && daysBetween_(d, bounds.end) >= 0) total += Number(t.amount);
  });
  return total;
}

function getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, periodId, startDay) {
  var categoryNameById = {};
  categories.forEach(function (c) { categoryNameById[c.id] = c.name; });

  var statuses = [];
  periodBudgetRows.filter(function (b) { return b.period_id === periodId; }).forEach(function (b) {
    var spent = getActualSpendInPeriod_(transactions, b.category_id, periodId, startDay);
    var amount = Number(b.amount);
    statuses.push({
      category_id: b.category_id,
      category_name: categoryNameById[b.category_id] || "?",
      amount: amount,
      spent: spent,
      remaining: amount - spent,
      pct_used: amount > 0 ? (spent / amount * 100) : 0,
      over_budget: spent > amount,
    });
  });
  return statuses;
}

function actionSetPeriodBudget_(params) {
  var categoryId = Number(params.category_id);
  var periodId = String(params.period_id || "");
  var amount = parseAmountVnd_(params.amount);
  if (amount <= 0) throw new Error("So tien phai lon hon 0.");
  if (!periodId.match(/^\d{4}-\d{2}$/)) throw new Error("period_id khong hop le.");

  var sheet = getSheet_(SHEET_PERIOD_BUDGETS);
  var rows = sheetRowsAsObjects_(sheet, PERIOD_BUDGETS_HEADER);
  var existing = null;
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i].category_id) === categoryId && rows[i].period_id === periodId) { existing = i; break; }
  }
  if (existing !== null) {
    var rowIndex = existing + 2;
    var amountCol = PERIOD_BUDGETS_HEADER.indexOf("amount") + 1;
    sheet.getRange(rowIndex, amountCol).setValue(amount);
    return { id: rows[existing].id, updated: true };
  }
  var id = nextId_(sheet, PERIOD_BUDGETS_HEADER);
  sheet.appendRow([id, categoryId, periodId, amount]);
  return { id: id, updated: false };
}

// ---------- Goals (mirrors get_goal_progress - linear schedule) ----------

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

  var totalPeriods = Math.max(periodsBetween_(createdId, deadlineId) + 1, 1);
  var elapsedPeriods = Math.min(Math.max(periodsBetween_(createdId, currentId) + 1, 0), totalPeriods);
  var expectedPct = elapsedPeriods / totalPeriods * 100;

  var isOverdue = daysBetween_(asOf, deadline) < 0 && remainingAmount > 0;
  var isOffTrack = !isOverdue && (progressPct + 5 < expectedPct);

  return {
    progress_pct: progressPct, remaining_amount: remainingAmount,
    periods_remaining: periodsRemaining, required_per_period: requiredPerPeriod,
    is_overdue: isOverdue, is_off_track: isOffTrack,
  };
}

function periodsBetween_(periodIdA, periodIdB) {
  var a = periodIdA.split("-"), b = periodIdB.split("-");
  var yearA = Number(a[0]), monthA = Number(a[1]);
  var yearB = Number(b[0]), monthB = Number(b[1]);
  return (yearB - yearA) * 12 + (monthB - monthA);
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
  var createdAt = dateToStr_(todayParts_());
  sheet.appendRow([id, name, params.goal_type || "custom", targetAmount, deadline, accountId, createdAt, true]);
  return { id: id };
}

function actionDeactivateGoal_(params) {
  var id = Number(params.id);
  var sheet = getSheet_(SHEET_GOALS);
  var rowIndex = findRowIndexById_(sheet, GOALS_HEADER, id);
  if (rowIndex === -1) return { deactivated: false };
  var col = GOALS_HEADER.indexOf("is_active") + 1;
  sheet.getRange(rowIndex, col).setValue(false);
  return { deactivated: true };
}

// ---------- Forecast (mirrors risk.project_simple_trajectory - the SIMPLE one) ----------

// Average income/expense per period over the last N completed periods that
// have any transaction (transfers excluded) - the "business as usual" run
// rate, same as risk.get_baseline_period_flow.
function getBaselinePeriodFlow_(transactions, transferCategoryIds, startDay, asOf) {
  var currentId = currentPeriodId_(startDay, asOf);
  var incomeByPeriod = {}, expenseByPeriod = {}, seenPeriods = {};
  transactions.forEach(function (t) {
    if (transferCategoryIds[t.category_id]) return;
    var pid = periodIdFor_(parseDateOnly_(t.occurred_at), startDay);
    if (pid >= currentId) return;
    seenPeriods[pid] = true;
    if (t.direction === "in") incomeByPeriod[pid] = (incomeByPeriod[pid] || 0) + Number(t.amount);
    else expenseByPeriod[pid] = (expenseByPeriod[pid] || 0) + Number(t.amount);
  });
  var periodIds = Object.keys(seenPeriods).sort().reverse().slice(0, BASELINE_FLOW_LOOKBACK_PERIODS);
  if (periodIds.length === 0) return { avgIncome: 0, avgExpense: 0 };
  var totalIncome = 0, totalExpense = 0;
  periodIds.forEach(function (pid) {
    totalIncome += incomeByPeriod[pid] || 0;
    totalExpense += expenseByPeriod[pid] || 0;
  });
  return { avgIncome: totalIncome / periodIds.length, avgExpense: totalExpense / periodIds.length };
}

function actionGetForecast_(params) {
  var periodsAhead = Math.max(1, Math.min(Number(params.periods_ahead) || 6, 12));
  var startDay = getPeriodStartDay_();
  var asOf = todayParts_();

  var accounts = sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER);
  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  var transferCategoryIds = getTransferCategoryIds_(categories);

  var flow = getBaselinePeriodFlow_(transactions, transferCategoryIds, startDay, asOf);
  var balance = getLiquidBalance_(accounts);
  var currentId = currentPeriodId_(startDay, asOf);

  var periods = [];
  for (var i = 0; i < periodsAhead; i++) {
    balance = balance + flow.avgIncome - flow.avgExpense;
    periods.push({
      period_id: shiftPeriodId_(currentId, i + 1, startDay),
      projected_balance: Math.round(balance),
    });
  }
  return { periods: periods, avg_income: Math.round(flow.avgIncome), avg_expense: Math.round(flow.avgExpense) };
}

// ---------- Bootstrap (everything the page needs in one round trip) ----------

function actionBootstrap_(params) {
  var startDay = getPeriodStartDay_();
  var asOf = todayParts_();

  var accountsAll = sheetRowsAsObjects_(getSheet_(SHEET_ACCOUNTS), ACCOUNTS_HEADER);
  var accounts = accountsAll.filter(function (a) { return isActive_(a.is_active); });
  var categories = sheetRowsAsObjects_(getSheet_(SHEET_CATEGORIES), CATEGORIES_HEADER);
  var transactions = sheetRowsAsObjects_(getSheet_(SHEET_TRANSACTIONS), TRANSACTIONS_HEADER);
  transactions.sort(function (a, b) { return (a.occurred_at < b.occurred_at) ? 1 : -1; });

  var accountNameById = {};
  accountsAll.forEach(function (a) { accountNameById[a.id] = a.name; });
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

  var transferCategoryIds = getTransferCategoryIds_(categories);
  var income = 0, expense = 0;
  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  transactions.forEach(function (t) {
    if (String(t.occurred_at).slice(0, 7) !== thisMonth) return;
    if (transferCategoryIds[t.category_id]) return; // moved between own accounts, not real income/expense
    if (t.direction === "in") income += Number(t.amount);
    else expense += Number(t.amount);
  });

  // Canh bao rui ro
  var liquidBalance = getLiquidBalance_(accounts);
  var essentialExpense = getAverageEssentialExpensePerPeriod_(transactions, categories, startDay, asOf);
  var runway = runwayMonths_(liquidBalance, essentialExpense);
  var daysInfo = daysElapsedAndRemaining_(asOf, startDay);
  var dailySpend = getAverageDailySpend_(transactions, transferCategoryIds, asOf, SPEND_LOOKBACK_DAYS);
  var forecast = shortTermForecast_(liquidBalance, dailySpend, daysInfo.remaining);
  var alerts = getActiveAlerts_(liquidBalance, essentialExpense, runway, forecast);

  // Ngan sach ky nay - PeriodBudgets is a v2 tab; a v1 Sheet that hasn't
  // added it yet just gets an empty budget list here instead of the whole
  // bootstrap (and therefore the whole page) throwing.
  var periodId = currentPeriodId_(startDay, asOf);
  var periodBudgetsSheet = getSheetOptional_(SHEET_PERIOD_BUDGETS);
  var periodBudgetRows = periodBudgetsSheet ? sheetRowsAsObjects_(periodBudgetsSheet, PERIOD_BUDGETS_HEADER) : [];
  var budgetStatuses = getPeriodBudgetStatus_(periodBudgetRows, transactions, categories, periodId, startDay);

  // Muc tieu - same v1-compatibility reasoning as PeriodBudgets above.
  var goalsSheet = getSheetOptional_(SHEET_GOALS);
  var goalsAll = goalsSheet ? sheetRowsAsObjects_(goalsSheet, GOALS_HEADER) : [];
  var goals = goalsAll.filter(function (g) { return isActive_(g.is_active); }).map(function (g) {
    var progress = getGoalProgress_(g, accountsAll, startDay, asOf);
    return {
      id: g.id, name: g.name, goal_type: g.goal_type, target_amount: g.target_amount,
      deadline: g.deadline, account_name: accountNameById[g.account_id] || "?",
      current_balance: (accountsAll.filter(function (a) { return Number(a.id) === Number(g.account_id); })[0] || {}).balance || 0,
      progress_pct: progress.progress_pct, remaining_amount: progress.remaining_amount,
      periods_remaining: progress.periods_remaining, required_per_period: progress.required_per_period,
      is_overdue: progress.is_overdue, is_off_track: progress.is_off_track,
    };
  });

  return {
    accounts: accounts,
    categories: categories,
    transactions: recent,
    summary: { income: income, expense: expense, month: thisMonth },
    alerts: alerts,
    risk: {
      has_data: essentialExpense !== null,
      liquid_balance: liquidBalance,
      essential_expense: essentialExpense,
      runway_months: runway.months,
      runway_level: runway.level,
      forecast_balance: forecast.forecastBalance,
      at_risk: forecast.atRisk,
      days_remaining: daysInfo.remaining,
    },
    period_id: periodId,
    budget_statuses: budgetStatuses,
    goals: goals,
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
  var necessity = params.necessity === "essential" || params.necessity === "optional" ? params.necessity : "";
  var sheet = getSheet_(SHEET_CATEGORIES);
  var id = nextId_(sheet, CATEGORIES_HEADER);
  sheet.appendRow([id, name, kind, params.parent_id || "", necessity, ""]);
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

// ---------- AI summary (Gemini via UrlFetchApp - no separate server needed) ----------
//
// Mirrors the main app's standing AI rule: the model never computes a new
// number, only interprets numbers already computed above in plain
// JavaScript. Gracefully unavailable (never throws to the client) if no
// GEMINI_API_KEY is set, or the call fails for any reason - same
// degradation contract as services/ai_client.get_ai_suggestion.
function actionGetAiSummary_(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { available: false, reason: "no_key" };

  var boot = actionBootstrap_(params);
  var data = {
    thang: boot.summary.month,
    thu_thang_nay: boot.summary.income,
    chi_thang_nay: boot.summary.expense,
    so_du_thanh_khoan: boot.risk.liquid_balance,
    so_ky_du_tru: boot.risk.runway_months,
    muc_do_nen_mong: boot.risk.runway_level,
    du_bao_cuoi_ky: boot.risk.forecast_balance,
    canh_bao_dang_co: boot.alerts.map(function (a) { return a.message; }),
    ngan_sach_vuot_muc: boot.budget_statuses.filter(function (s) { return s.over_budget; }).map(function (s) { return s.category_name; }),
    muc_tieu_tong: boot.goals.length,
    muc_tieu_cham_tien_do: boot.goals.filter(function (g) { return g.is_off_track || g.is_overdue; }).map(function (g) { return g.name; }),
  };

  var prompt = "Ban la tro ly tai chinh ca nhan. Duoi day la cac chi so tai chinh cua nguoi dung HOM NAY, " +
    "da duoc tinh san chinh xac bang JavaScript (KHONG phai ban tinh). " +
    "QUAN TRONG: ban KHONG duoc tu tinh toan so lieu moi, khong duoc bia so khong co trong du lieu. " +
    "Viet 1 nhan xet ngan gon (2-3 cau, tieng Viet) tom tat tinh hinh hom nay, neu bat dieu dang chu y nhat, " +
    "giong dieu diem tinh, khong gay hoang mang. Du lieu (JSON): " + JSON.stringify(data);

  try {
    var response = UrlFetchApp.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=" + apiKey,
      {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        muteHttpExceptions: true,
      }
    );
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      return { available: false, reason: "network" };
    }
    var parsed = JSON.parse(response.getContentText());
    var text = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content &&
      parsed.candidates[0].content.parts && parsed.candidates[0].content.parts[0] &&
      parsed.candidates[0].content.parts[0].text;
    if (!text) return { available: false, reason: "invalid_response" };
    return { available: true, summary: text.trim() };
  } catch (err) {
    return { available: false, reason: "network" };
  }
}
