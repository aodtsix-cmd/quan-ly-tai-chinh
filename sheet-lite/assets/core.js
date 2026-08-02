/* =========================================================================
   core.js - connection config, the Apps Script API client, and the
   formatting/parsing helpers every view shares.
   Plain <script> (no ES modules) on purpose, so index.html still works when
   opened straight off the filesystem with file:// rather than a server.
   ========================================================================= */

var App = window.App || {};
window.App = App;

// ------------------------------------------------------------------ config

App.STORAGE_KEY = "sheet_lite_config";
App.THEME_KEY = "sheet_lite_theme";

App.loadConfig = function () {
  try {
    return JSON.parse(localStorage.getItem(App.STORAGE_KEY) || "null");
  } catch (err) {
    return null;
  }
};

App.saveConfig = function (config) {
  localStorage.setItem(App.STORAGE_KEY, JSON.stringify(config));
};

App.clearConfig = function () {
  localStorage.removeItem(App.STORAGE_KEY);
};

// --------------------------------------------------------------- api client

App.config = null;

// GET is used for reads. Apps Script Web Apps answer both, but a GET keeps
// read requests cacheable-looking and shows up clearly in the network tab.
App.apiGet = function (action, extraParams) {
  var params = new URLSearchParams(
    Object.assign({ action: action, token: App.config.token }, extraParams || {})
  );
  return fetch(App.config.url + "?" + params.toString())
    .then(App.parseResponse)
    .then(App.unwrap);
};

// Apps Script answers with 200 + an HTML page rather than JSON in several
// ordinary situations: a stale or mistyped deployment URL, a deployment that
// was deleted, or one that is still propagating in the first minute after
// "Triển khai" (observed live - two calls returned Google's "Không tìm thấy
// trang" page before the third returned real JSON). Left alone, response.json()
// throws "Unexpected token '<'", which tells the user nothing.
App.parseResponse = function (response) {
  return response.text().then(function (text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      var looksLikeGooglePage = text.indexOf("<") === 0;
      throw new Error(looksLikeGooglePage
        ? "Google trả về một trang web thay vì dữ liệu. Thường là URL Web App sai, bản triển khai đã bị xóa, hoặc bạn vừa bấm Triển khai xong và nó chưa kịp có hiệu lực — đợi khoảng một phút rồi bấm Thử lại."
        : "Phản hồi từ máy chủ không đọc được.");
    }
  });
};

// The body goes out as text/plain, NOT application/json, on purpose: Apps
// Script Web Apps don't answer CORS preflight (OPTIONS) requests, and a
// custom application/json content type makes the browser send one. text/plain
// is a CORS "simple request" so no preflight happens, and Code.gs parses the
// body as JSON regardless of the declared type.
App.apiPost = function (action, body) {
  return fetch(App.config.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action: action, token: App.config.token }, body || {})),
  })
    .then(App.parseResponse)
    .then(App.unwrap);
};

// Turns the {ok, data|message} envelope into a resolved value or a rejected
// promise, so every caller can use a single .catch for both a transport
// failure and a server-side error.
App.unwrap = function (payload) {
  if (payload && payload.ok) return payload.data;
  var message = (payload && payload.message) || "Máy chủ trả về lỗi không rõ.";
  return Promise.reject(new Error(message));
};

App.errorText = function (err) {
  var message = String((err && err.message) || err);
  if (message.indexOf("Failed to fetch") !== -1 || message.indexOf("NetworkError") !== -1) {
    return "Không kết nối được với Apps Script. Kiểm tra lại URL trong Cài đặt, và chắc chắn bản deploy đang mở cho \"Anyone with the link\".";
  }
  if (message.indexOf("Sai token") !== -1) {
    return "Sai mã kết nối. Xem lại mã đúng ở Google Sheet: menu Sổ tài chính → ② Xem mã kết nối, rồi nhập lại ở Cài đặt.";
  }
  if (message.indexOf("Chua dat APP_TOKEN") !== -1) {
    return "Bảng tính chưa có mã kết nối. Mở Apps Script và chạy hàm setupEverything một lần — nó sẽ tạo và hiện mã cho bạn.";
  }
  return message;
};

// ------------------------------------------------------------- number format

App.formatVnd = function (value) {
  var rounded = Math.round(Number(value) || 0);
  return new Intl.NumberFormat("vi-VN").format(rounded);
};

App.formatDong = function (value) {
  return App.formatVnd(value) + " đ";
};

// Short form for tight spots (metric tiles, chart axes): 1,2 tr / 850 ng.
App.formatCompact = function (value) {
  var n = Number(value) || 0;
  var sign = n < 0 ? "-" : "";
  var abs = Math.abs(n);
  if (abs >= 1e9) return sign + trimZero(abs / 1e9) + " tỷ";
  if (abs >= 1e6) return sign + trimZero(abs / 1e6) + " tr";
  if (abs >= 1e3) return sign + trimZero(abs / 1e3) + " ng";
  return sign + String(Math.round(abs));
};

function trimZero(value) {
  return value.toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

App.formatPct = function (value, digits) {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(digits === undefined ? 0 : digits).replace(".", ",") + "%";
};

App.formatNumber = function (value, digits) {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(digits === undefined ? 1 : digits).replace(".", ",");
};

// ---------------------------------------------------------------- date format

App.today = function () {
  var now = new Date();
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
};

function pad2(n) { return n < 10 ? "0" + n : String(n); }

App.dateOnly = function (timestamp) {
  return String(timestamp || "").slice(0, 10);
};

// "16/07" - the compact form used in lists, where the year is almost always
// obvious from context.
App.formatDayMonth = function (dateStr) {
  var parts = App.dateOnly(dateStr).split("-");
  if (parts.length < 3) return dateStr;
  return parts[2] + "/" + parts[1];
};

App.WEEKDAYS = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];

App.formatDateHeading = function (dateStr) {
  var iso = App.dateOnly(dateStr);
  if (iso === App.today()) return "Hôm nay";
  var parts = iso.split("-");
  if (parts.length < 3) return iso;
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return App.WEEKDAYS[date.getDay()] + ", " + parts[2] + "/" + parts[1];
};

// A period id is "YYYY-MM" (the period's START month) - shown as the real
// date range so it's never mistaken for a calendar month.
App.formatPeriodRange = function (period) {
  return App.formatDayMonth(period.start) + " – " + App.formatDayMonth(period.end);
};

// ------------------------------------------------------------ amount parsing

// Mirrors Code.gs's parseAmountVnd_, which stays authoritative - this copy
// only powers the live preview under the amount field and the "is this a big
// purchase?" check, so it never needs to be the final word.
App.AMOUNT_UNITS = {
  k: 1e3, nghin: 1e3, "nghìn": 1e3,
  tr: 1e6, trieu: 1e6, "triệu": 1e6,
  ty: 1e9, "tỷ": 1e9,
};

App.tryParseAmount = function (text) {
  var raw = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;

  var trailingDigit = raw.match(/^(\d+)(tr|trieu|triệu)(\d)$/);
  if (trailingDigit) {
    return Math.round((Number(trailingDigit[1]) + Number(trailingDigit[3]) / 10) * 1e6);
  }
  var unitMatch = raw.match(/^(\d+(?:[.,]\d+)?)(k|nghin|nghìn|tr|trieu|triệu|ty|tỷ)$/);
  if (unitMatch) {
    return Math.round(parseFloat(unitMatch[1].replace(",", ".")) * App.AMOUNT_UNITS[unitMatch[2]]);
  }
  var digits = raw.replace(/[.,]/g, "");
  return /^\d+$/.test(digits) ? parseInt(digits, 10) : null;
};

// ------------------------------------------------------------- DOM helpers

App.$ = function (selector, root) { return (root || document).querySelector(selector); };
App.$$ = function (selector, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(selector));
};

// Every value interpolated into an HTML string goes through this. Account
// names, descriptions and category names are all free text the user typed.
App.esc = function (value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

App.setHtml = function (selector, html) {
  var node = App.$(selector);
  if (node) node.innerHTML = html;
};

App.show = function (selector, visible) {
  var node = App.$(selector);
  if (node) node.classList.toggle("hidden", !visible);
};

// ------------------------------------------------------------------- theme

App.applyTheme = function (theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
};

App.currentTheme = function () {
  return localStorage.getItem(App.THEME_KEY) || "auto";
};

// Cycles auto -> light -> dark so the OS default is always reachable again.
App.cycleTheme = function () {
  var order = ["auto", "light", "dark"];
  var next = order[(order.indexOf(App.currentTheme()) + 1) % order.length];
  localStorage.setItem(App.THEME_KEY, next);
  App.applyTheme(next);
  return next;
};

App.applyTheme(App.currentTheme());
