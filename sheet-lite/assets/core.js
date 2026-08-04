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
      throw new Error(looksLikeGooglePage ? App.t("error.html_response") : App.t("error.unreadable_response"));
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
  var message = (payload && payload.message) || App.t("error.unknown_server");
  return Promise.reject(new Error(message));
};

// Deliberately token-less: a deployment running old code rejects the token
// check before it can identify itself, so this is the only way to find out
// what is actually deployed. Resolves to null when the deployment is too old
// to answer at all - which is itself the answer.
App.EXPECTED_VERSION = "3.6";

App.fetchVersionFor = function (url) {
  return fetch(url + "?action=version")
    .then(App.parseResponse)
    .then(function (payload) { return (payload && payload.ok && payload.data.version) || null; })
    .catch(function () { return null; });
};

App.fetchVersion = function () {
  return App.fetchVersionFor(App.config.url);
};

App.errorText = function (err) {
  var message = String((err && err.message) || err);
  if (message.indexOf("Failed to fetch") !== -1 || message.indexOf("NetworkError") !== -1) {
    return App.t("error.network");
  }
  if (message.indexOf("Sai token") !== -1) {
    return App.t("error.bad_token");
  }
  // A feature the frontend knows about but the deployed Code.gs doesn't yet.
  // The raw text leaks an internal action name and helps nobody.
  if (message.indexOf("Hanh dong khong hop le") !== -1) {
    return App.t("error.old_backend");
  }
  if (message.indexOf("Chua dat APP_TOKEN") !== -1) {
    return App.t("error.no_token_set");
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

// Weekday names and "Today" are natural-language words, so they follow the
// chosen UI language - unlike the numeric dd/mm they're paired with, which
// stays the same in both languages (this app doesn't switch date order,
// only the words around it).
App.WEEKDAYS = {
  vi: ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

App.formatDateHeading = function (dateStr) {
  var iso = App.dateOnly(dateStr);
  if (iso === App.today()) return App.t("common.today");
  var parts = iso.split("-");
  if (parts.length < 3) return iso;
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var names = App.WEEKDAYS[App.currentLang()] || App.WEEKDAYS.vi;
  return names[date.getDay()] + ", " + parts[2] + "/" + parts[1];
};

// A period id is "YYYY-MM" (the period's START month) - shown as the real
// date range so it's never mistaken for a calendar month.
App.formatPeriodRange = function (period) {
  return App.formatDayMonth(period.start) + " – " + App.formatDayMonth(period.end);
};

// Whole calendar days between today and a "YYYY-MM-DD"-ish date string,
// rounded rather than floored/ceiled so a due time earlier today doesn't
// read as "-1 ngày" from a few hours of clock drift between browser and
// server. Used for the recurring-item countdown on the Nhà dashboard.
App.daysUntil = function (dateStr) {
  var iso = App.dateOnly(dateStr);
  var parts = iso.split("-");
  if (parts.length < 3) return null;
  var target = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var todayParts = App.today().split("-");
  var today = new Date(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2]));
  return Math.round((target - today) / 86400000);
};

// "Spotify" -> "S", "Google AI Pro" -> "GA" - a stand-in monogram tile for a
// recurring item with no real logo. Never guesses a brand mark; see the
// design handoff's own note that real logos are a placeholder to replace.
App.initials = function (name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
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

  // Digits after the unit are the fractional part: 2tr5 = 2.5, 1tr25 = 1.25.
  var trailingDigit = raw.match(/^(\d+)(tr|trieu|triệu)(\d{1,3})$/);
  if (trailingDigit) {
    return Math.round((Number(trailingDigit[1]) + Number("0." + trailingDigit[3])) * 1e6);
  }
  var unitMatch = raw.match(/^(\d+(?:[.,]\d+)?)(k|nghin|nghìn|tr|trieu|triệu|ty|tỷ)$/);
  if (unitMatch) {
    return Math.round(parseFloat(unitMatch[1].replace(",", ".")) * App.AMOUNT_UNITS[unitMatch[2]]);
  }
  var digits = raw.replace(/[.,]/g, "");
  return /^\d+$/.test(digits) ? parseInt(digits, 10) : null;
};

// Groups digits with thousand separators AS YOU TYPE, so 10000000 reads as
// 10.000.000 and can't be mistaken for 1.000.000 at a glance - the single
// easiest way to record a wrong amount.
//
// Two rules make this safe. It bails the moment a letter appears, so typing
// the shorthand "1tr" is never mangled (the main Flask app once chewed "1tr"
// down to "1" keystroke by keystroke and saved 1 đồng). And it restores the
// caret by counting digits, not characters, so inserting a separator doesn't
// throw the cursor to the end mid-word.
App.formatAmountInput = function (input) {
  var raw = input.value;
  if (/[a-zA-Z]/.test(raw)) return;

  var digits = raw.replace(/\D/g, "").slice(0, 15);
  if (!digits) {
    if (raw !== "") input.value = "";
    return;
  }
  var formatted = new Intl.NumberFormat("vi-VN").format(Number(digits));
  if (formatted === raw) return;

  var caret = input.selectionStart === null ? raw.length : input.selectionStart;
  var digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, "").length;
  input.value = formatted;

  var position = 0, seen = 0;
  while (position < formatted.length && seen < digitsBeforeCaret) {
    if (/\d/.test(formatted.charAt(position))) seen++;
    position++;
  }
  try { input.setSelectionRange(position, position); } catch (err) { /* not all inputs support it */ }
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

// ------------------------------------------------------------------- icons

// One line-art set, drawn on a 24-box, stroked with currentColor so every
// glyph inherits whatever colour its container sets. Inline rather than an
// icon font or an SVG sprite: this page's whole selling point is that it
// fetches nothing it doesn't have to.
App.ICONS = {
  home: '<path d="M3 10.5 12 3.5l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  food: '<path d="M6 3v8a2.5 2.5 0 0 0 5 0V3"/><path d="M8.5 11v10"/><path d="M17 3c-1.5 1.5-2 3.5-2 5.5S15.5 12 17 12v9"/>',
  car: '<path d="M4 16v-3.5L6 7h12l2 5.5V16"/><path d="M4 16h16v2.5h-3V16M7 18.5H4V16"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/>',
  book: '<path d="M4 4.5h6a2.5 2.5 0 0 1 2 2.5v12a2 2 0 0 0-2-1.5H4Z"/><path d="M20 4.5h-6a2.5 2.5 0 0 0-2 2.5v12a2 2 0 0 1 2-1.5h6Z"/>',
  // A cross in a rounded square, not a heart: "Sức khỏe" and "Mối quan hệ"
  // sat side by side in the picker as two near-identical hearts.
  health: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18l-1.8-5.4L4.5 10.8 10.2 9Z"/><path d="M18.5 4v3M17 5.5h3"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.2A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.8C19 15.6 12 20 12 20Z"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17 14.2a5.5 5.5 0 0 1 3.5 4.8"/>',
  bank: '<path d="M3.5 9.5 12 4.5l8.5 5"/><path d="M5.5 9.5V17M9.5 9.5V17M14.5 9.5V17M18.5 9.5V17"/><path d="M3.5 19.5h17"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3"/><path d="M4 7.5V17a2 2 0 0 0 2 2h13V8H6a2 2 0 0 1-2-1.9"/><circle cx="15.5" cy="13.5" r="1"/>',
  cash: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 12h.01M17.5 12h.01"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><path d="M6.5 14.5h3"/>',
  gift: '<rect x="3.5" y="9" width="17" height="4" rx="1"/><path d="M5 13v7h14v-7"/><path d="M12 9v11"/><path d="M12 9S10.5 4 8.5 4a2 2 0 0 0 0 5M12 9s1.5-5 3.5-5a2 2 0 0 1 0 5"/>',
  plane: '<path d="M10.5 4.5a1.5 1.5 0 0 1 3 0V10l7 4v2l-7-2v3.5l2 1.5v1.5l-3.5-1-3.5 1V19l2-1.5V14l-7 2v-2l7-4Z"/>',
  bolt: '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12Z"/>',
  wifi: '<path d="M4 9.5a12 12 0 0 1 16 0"/><path d="M7 13a7.5 7.5 0 0 1 10 0"/><path d="M10 16.4a3 3 0 0 1 4 0"/><path d="M12 19.5h.01"/>',
  shirt: '<path d="M9 4.5 5 6.5l1 4 2-.7V20h8V9.8l2 .7 1-4-4-2a3 3 0 0 1-6 0Z"/>',
  // Sprocket holes down both edges, so it reads as film and not as a table.
  film: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.5 5.5v13M16.5 5.5v13"/><path d="M5.5 9h.01M5.5 12h.01M5.5 15h.01M18.5 9h.01M18.5 12h.01M18.5 15h.01"/>',
  repeat: '<path d="M4 10a5 5 0 0 1 5-5h9"/><path d="M15 2.5 18.5 5 15 7.5"/><path d="M20 14a5 5 0 0 1-5 5H6"/><path d="M9 21.5 5.5 19 9 16.5"/>',
  salary: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9h5M9.5 12h5"/><path d="M10 9c0 4.5 4 3 4 6.5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M7.5 15 11 10.5l3 3L20 7"/>',
  scale: '<path d="M12 4v16M7 20h10"/><path d="M4 9h16"/><path d="M4 9 1.5 14.5a3 3 0 0 0 5 0Z"/><path d="M20 9l2.5 5.5a3 3 0 0 1-5 0Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  shield: '<path d="M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6Z"/><path d="M9.5 12l1.8 1.8L15 10"/>',
  pie: '<path d="M12 3.5v8.5h8.5A8.5 8.5 0 0 0 12 3.5Z"/><path d="M20 15.5A8.5 8.5 0 1 1 9.5 4"/>',
  dots: '<circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>',
  swap: '<path d="M4 8.5h13"/><path d="M14 5 17.5 8.5 14 12"/><path d="M20 15.5H7"/><path d="M10 12 6.5 15.5 10 19"/>',
  plus: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  gear: '<path d="M4 8h8M16 8h4M4 16h4M12 16h8"/><circle cx="14" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="8.5" cy="10" r="1.5"/><path d="M4 17l4.5-4.5L12 16l3-3 5 5"/>',
  back: '<path d="M19 12H5"/><path d="M11 6 5 12l6 6"/>',
  bell: '<path d="M6 10.5a6 6 0 0 1 12 0c0 3.5 1 5 2 6.5H4c1-1.5 2-3 2-6.5Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  // Leaf-level glyphs. Without these, drilling into a parent shows four tiles
  // wearing the same icon, which is worse than no icon at all - the row stops
  // carrying any information and only the text does any work.
  coffee: '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7 4.5v1.5M10.5 3.5v2.5M14 4.5v1.5"/>',
  basket: '<path d="M4 9h16l-1.6 8.5a2 2 0 0 1-2 1.5H7.6a2 2 0 0 1-2-1.5Z"/><path d="m8.5 9 2-4.5M15.5 9l-2-4.5"/><path d="M10 12.5v3M14 12.5v3"/>',
  fuel: '<path d="M4.5 20V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/><path d="M3.5 20h10"/><path d="M5.5 10h6"/><path d="M13 8.5h2.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V10l-2-2.5"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M10 16.5v-9h2.75a2.75 2.75 0 0 1 0 5.5H10"/>',
  wrench: '<path d="M15.5 3.5a5 5 0 0 0-4.2 7.6L3.8 18.6a1.8 1.8 0 0 0 2.6 2.6l7.5-7.5a5 5 0 0 0 6.1-6.6l-2.8 2.8-2.6-.7-.7-2.6Z"/>',
  cap: '<path d="M12 4.5 2.5 9 12 13.5 21.5 9Z"/><path d="M6.5 11v5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
  sort: '<path d="M8 5v14M8 19 4.5 15.5M8 19l3.5-3.5"/><path d="M16 19V5M16 5l3.5 3.5M16 5l-3.5 3.5"/>',
};

App.icon = function (name, className) {
  var body = App.ICONS[name] || App.ICONS.dots;
  return '<svg viewBox="0 0 24 24" aria-hidden="true"' +
    (className ? ' class="' + className + '"' : "") + ">" + body + "</svg>";
};

// Diacritics are stripped before matching so one keyword list covers both
// "Ăn uống" and anything typed without tone marks. The đ/Đ pair needs its own
// pass: it is a distinct letter, not a d with a mark, so NFD leaves it alone.
App.deaccent = function (text) {
  var value = String(text === null || text === undefined ? "" : text);
  if (value.normalize) {
    value = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  return value.replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
};

// Longest-match-first: "an uong" has to be tried before "an", and "the tin
// dung" before "the". Order in this list is therefore load-bearing.
App.CATEGORY_ICON_RULES = [
  // Income names are matched first: "Trợ cấp gia đình" is a salary-shaped
  // thing, and would otherwise be caught by the "gia dinh" expense rule.
  [["luong", "day hoc"], "salary"],
  [["tro cap", "hoc bong"], "wallet"],
  [["ban than"], "sparkle"],
  [["nha o", "tien phong", "thue nha"], "home"],
  [["dien nuoc", "dien", "nuoc"], "bolt"],
  [["internet", "wifi", "dien thoai"], "wifi"],
  [["ca phe", "tra sua"], "coffee"],
  [["di cho", "nau an"], "basket"],
  [["an uong", "an ngoai"], "food"],
  [["xang"], "fuel"],
  [["gui xe"], "parking"],
  [["sua xe"], "wrench"],
  [["di chuyen", "grab", "taxi", "xe buyt"], "car"],
  [["hoc phi", "khoa hoc"], "cap"],
  [["hoc tap", "sach", "tai lieu"], "book"],
  [["suc khoe", "kham benh", "thuoc"], "health"],
  [["bao hiem"], "shield"],
  [["du lich"], "plane"],
  [["quan ao", "lam dep"], "shirt"],
  [["giai tri", "xem phim"], "film"],
  [["dang ky dich vu"], "repeat"],
  [["moi quan he", "hen ho", "ban be"], "heart"],
  [["qua tang", "qua cho", "hieu hi"], "gift"],
  [["gia dinh"], "users"],
  [["tai chinh", "tra no", "tra gop"], "card"],
  [["tiet kiem", "dau tu"], "bank"],
  [["chuyen khoan"], "swap"],
  [["khac"], "dots"],
];

App.categoryIconName = function (categoryName) {
  var text = App.deaccent(categoryName);
  for (var i = 0; i < App.CATEGORY_ICON_RULES.length; i++) {
    var keywords = App.CATEGORY_ICON_RULES[i][0];
    for (var k = 0; k < keywords.length; k++) {
      if (text.indexOf(keywords[k]) !== -1) return App.CATEGORY_ICON_RULES[i][1];
    }
  }
  return "dots";
};

App.ACCOUNT_ICONS = { bank: "bank", ewallet: "wallet", cash: "cash", credit_card: "card", savings: "shield" };

// --------------------------------------------------------------- count-up

// The balance ticks up on load. It is decoration, but useful decoration: the
// movement pulls the eye to the number the whole screen is organised around.
// Anyone who has asked for reduced motion just gets the final value.
App.countUp = function (node, target, render) {
  var prefersStill = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var value = Number(target) || 0;
  if (prefersStill || !window.requestAnimationFrame || Math.abs(value) < 1000) {
    node.innerHTML = render(value);
    return;
  }
  var duration = 700;
  var started = null;
  function frame(now) {
    if (started === null) started = now;
    var t = Math.min((now - started) / duration, 1);
    // ease-out cubic: fast first, settling gently onto the real figure
    var eased = 1 - Math.pow(1 - t, 3);
    node.innerHTML = render(Math.round(value * eased));
    if (t < 1) window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
};

// ------------------------------------------------------------------- theme

App.PALETTE_KEY = "sheet_lite_palette";

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

App.setTheme = function (theme) {
  localStorage.setItem(App.THEME_KEY, theme);
  App.applyTheme(theme);
};

// Cycles auto -> light -> dark so the OS default is always reachable again.
App.cycleTheme = function () {
  var order = ["auto", "light", "dark"];
  var next = order[(order.indexOf(App.currentTheme()) + 1) % order.length];
  App.setTheme(next);
  return next;
};

// The palette is a second, independent axis: "cổ điển" has both a light and
// a dark form, so choosing a colour scheme must not silently choose light or
// dark for you.
App.PALETTES = [
  { key: "indigo", label: "Chàm", dot: "#4f46e5" },
  { key: "ocean", label: "Xanh", dot: "#0e7490" },
  { key: "classic", label: "Cổ điển", dot: "#7a5c2e" },
];

App.currentPalette = function () {
  return localStorage.getItem(App.PALETTE_KEY) || "indigo";
};

App.applyPalette = function (palette) {
  if (palette && palette !== "indigo") {
    document.documentElement.setAttribute("data-palette", palette);
  } else {
    document.documentElement.removeAttribute("data-palette");
  }
};

App.setPalette = function (palette) {
  localStorage.setItem(App.PALETTE_KEY, palette);
  App.applyPalette(palette);
};

App.applyTheme(App.currentTheme());
App.applyPalette(App.currentPalette());

// --------------------------------------------------------------- language
// Bilingual Vi/En, per docs/UI-DESIGN-SPEC.md §6. One flat table per
// language, dotted keys by screen. App.t(key, vars) looks the key up in the
// current language, falling back to Vietnamese and then the bare key so a
// missing translation degrades to *something* on screen rather than
// throwing. {{token}} in a value is replaced from `vars` - callers pass
// already-`App.esc`'d user text through vars themselves; t() never escapes,
// since half its own values legitimately contain markup (<b>, <code>).
//
// Money and dates are the deliberate exception per the spec: amounts always
// render as Vietnamese-formatted VND regardless of language (App.formatDong
// is untouched), and numeric dd/mm dates don't reorder - only the words
// around them (weekday names, "Hôm nay"/"Today") switch with the language.
App.LANG_KEY = "sheet_lite_lang";

App.LANGS = [
  { key: "vi", label: "Tiếng Việt" },
  { key: "en", label: "English" },
];

App.currentLang = function () {
  return localStorage.getItem(App.LANG_KEY) || "vi";
};

App.setLang = function (lang) {
  localStorage.setItem(App.LANG_KEY, lang);
  document.documentElement.setAttribute("lang", lang);
};

// The one piece of markup NOT owned by a render function: index.html's
// onboarding screen, tab bar, and the add-transaction form's own labels
// (that form is deliberately never re-rendered - see app.js's refreshAddForm
// comment - so its static text needs its own refresh path). Every such
// element carries data-i18n / data-i18n-placeholder / data-i18n-aria, and
// this walks them on boot and again on every language switch. innerHTML, not
// textContent - several dictionary values legitimately contain markup (<b>,
// <span class="num">), the same as everywhere else t() is used.
App.applyStaticI18n = function () {
  App.$$("[data-i18n]").forEach(function (el) { el.innerHTML = App.t(el.getAttribute("data-i18n")); });
  App.$$("[data-i18n-placeholder]").forEach(function (el) { el.setAttribute("placeholder", App.t(el.getAttribute("data-i18n-placeholder"))); });
  App.$$("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", App.t(el.getAttribute("data-i18n-aria"))); });
};

App.t = function (key, vars) {
  var dict = App.I18N[App.currentLang()] || App.I18N.vi;
  var template = dict[key];
  if (template === undefined) template = App.I18N.vi[key];
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, function (match, name) {
    return vars[name] !== undefined ? vars[name] : "";
  });
};

// Small closed vocabularies (health level, account type, ...) that render
// functions look up BY KEY rather than iterating - kept as language-keyed
// maps instead of routing every entry through App.t, since callers already
// have a stable key (level/type/frequency) and want the label back directly.
App.LABEL_MAPS = {
  health: {
    vi: { nguy_hiem: "Nguy hiểm", mong_manh: "Mong manh", on: "Ổn", vung: "Vững" },
    en: { nguy_hiem: "Danger", mong_manh: "Fragile", on: "OK", vung: "Strong" },
  },
  health_blurb: {
    vi: {
      nguy_hiem: "Quỹ dự phòng gần như không còn. Ưu tiên cắt chi và giữ tiền mặt.",
      mong_manh: "Có đệm nhưng mỏng. Một khoản bất ngờ là đủ để lệch kế hoạch.",
      on: "Đủ đệm cho vài kỳ. Có thể bắt đầu nghĩ tới mục tiêu dài hơn.",
      vung: "Nền móng chắc. Tiền đang làm việc thay vì chỉ nằm chờ.",
    },
    en: {
      nguy_hiem: "Your safety buffer is nearly gone. Cut spending and hold cash first.",
      mong_manh: "There's a cushion, but it's thin. One surprise expense is enough to derail the plan.",
      on: "Enough cushion for a few periods. You can start thinking about longer-term goals.",
      vung: "Solid foundation. Your money is working, not just sitting idle.",
    },
  },
  account_type: {
    vi: { bank: "Ngân hàng", ewallet: "Ví điện tử", cash: "Tiền mặt", credit_card: "Thẻ tín dụng", savings: "Sổ tiết kiệm" },
    en: { bank: "Bank", ewallet: "E-wallet", cash: "Cash", credit_card: "Credit card", savings: "Savings account" },
  },
  frequency: {
    vi: { weekly: "Hằng tuần", monthly: "Hằng tháng", quarterly: "Hằng quý", yearly: "Hằng năm" },
    en: { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" },
  },
  goal_type: {
    vi: { emergency_fund: "Quỹ khẩn cấp", savings: "Tiết kiệm", investment: "Đầu tư", medical: "Y tế", custom: "Khác" },
    en: { emergency_fund: "Emergency fund", savings: "Savings", investment: "Investment", medical: "Medical", custom: "Custom" },
  },
  traffic_light: {
    vi: { green: "An toàn", yellow: "Cần cân nhắc", red: "Rủi ro" },
    en: { green: "Safe", yellow: "Worth a second look", red: "Risky" },
  },
  category_kind: {
    vi: { expense: "Chi tiêu", income: "Thu nhập", transfer: "Chuyển khoản nội bộ" },
    en: { expense: "Expense", income: "Income", transfer: "Internal transfer" },
  },
  necessity: {
    vi: { "": "Chưa xác định", essential: "Thiết yếu", optional: "Tùy chọn" },
    en: { "": "Not set", essential: "Essential", optional: "Optional" },
  },
  stability: {
    vi: { "": "Chưa xác định", fixed: "Cố định", variable: "Thay đổi" },
    en: { "": "Not set", fixed: "Fixed", variable: "Variable" },
  },
  theme: {
    vi: { auto: "Tự động", light: "Sáng", dark: "Tối" },
    en: { auto: "Auto", light: "Light", dark: "Dark" },
  },
  palette: {
    vi: { indigo: "Chàm", ocean: "Xanh", classic: "Cổ điển" },
    en: { indigo: "Indigo", ocean: "Ocean", classic: "Classic" },
  },
  plan_section: {
    vi: { budget: "Ngân sách", goals: "Mục tiêu", events: "Sự kiện", income: "Thu nhập", recurring: "Định kỳ", forecast: "Dự báo", simulate: "Mô phỏng" },
    en: { budget: "Budget", goals: "Goals", events: "Events", income: "Income", recurring: "Recurring", forecast: "Forecast", simulate: "Simulate" },
  },
  trend: {
    vi: { improving: "đang cải thiện", declining: "đang đi xuống", stable: "đi ngang" },
    en: { improving: "improving", declining: "declining", stable: "stable" },
  },
};

App.label = function (mapName, key) {
  var map = App.LABEL_MAPS[mapName];
  if (!map) return key;
  var table = map[App.currentLang()] || map.vi;
  return table[key] !== undefined ? table[key] : (map.vi[key] !== undefined ? map.vi[key] : key);
};

App.I18N = {
  vi: {
    "error.network": "Không kết nối được với Apps Script. Kiểm tra lại URL trong Cài đặt, và chắc chắn bản deploy đang mở cho \"Anyone with the link\".",
    "error.bad_token": "Sai mã kết nối. Xem lại mã đúng ở Google Sheet: menu Sổ tài chính → ② Xem mã kết nối, rồi nhập lại ở Cài đặt.",
    "error.old_backend": "Bảng tính đang chạy bản mã cũ hơn nên chưa có tính năng này. Dán lại Code.gs mới nhất rồi triển khai với “Phiên bản: Mới” là dùng được.",
    "error.no_token_set": "Bảng tính chưa có mã kết nối. Mở Apps Script và chạy hàm setupEverything một lần — nó sẽ tạo và hiện mã cho bạn.",
    "error.html_response": "Google trả về một trang web thay vì dữ liệu. Thường là URL Web App sai, bản triển khai đã bị xóa, hoặc bạn vừa bấm Triển khai xong và nó chưa kịp có hiệu lực — đợi khoảng một phút rồi bấm Thử lại.",
    "error.unreadable_response": "Phản hồi từ máy chủ không đọc được.",
    "error.unknown_server": "Máy chủ trả về lỗi không rõ.",

    "common.today": "Hôm nay",
    "common.edit": "Sửa",
    "common.delete": "Xóa",
    "common.hide": "Ẩn",
    "common.stop": "Ngừng",
    "common.view_all": "Xem tất cả",
    "common.manage": "Quản lý",
    "common.change": "Đổi",
    "common.close": "Đóng",
    "common.back": "Quay lại",
    "common.saving": "Đang lưu…",
    "common.checking": "Đang kiểm tra…",
    "common.creating": "Đang tạo…",
    "common.use_suggestion": "Dùng gợi ý",
    "common.all_sections_aria": "Tất cả khu vực",
    "common.uncategorized_placeholder": "— Chưa phân loại —",
    "common.custom_from_scratch": "— Tự nhập từ đầu —",
    "common.not_categorized": "Không ghi chú",
    "common.no_description_row": "Không ghi chú",
    "common.recurring_tag": "định kỳ",

    "nav.home": "Nhà",
    "nav.add": "Nhập",
    "nav.list": "Sổ",
    "nav.plan": "Kế hoạch",
    "nav.settings": "Cài đặt",

    "onboarding.eyebrow": "Bước cuối",
    "onboarding.title": "Nối vào Google Sheet của bạn",
    "onboarding.intro": "Trang này là giao diện; sổ của bạn nằm trong Google Sheet của chính bạn. Điền hai ô dưới đây một lần duy nhất để nối chúng lại — máy sẽ nhớ, lần sau mở là vào thẳng.",
    "onboarding.url_label": "Địa chỉ bảng tính",
    "onboarding.url_hint": "Lấy trong Apps Script: <b>Triển khai → Bản triển khai mới → Ứng dụng web</b>, rồi copy URL hiện ra. Nó kết thúc bằng <span class=\"num\">/exec</span>.",
    "onboarding.token_label": "Mã kết nối",
    "onboarding.token_placeholder": "VD: K7RQ-2MXP-9TFA",
    "onboarding.token_hint": "Mã do bảng tính tự sinh ra. Xem lại bất cứ lúc nào ở menu <b>Sổ tài chính → ② Xem mã kết nối</b> trên thanh công cụ Google Sheet.",
    "onboarding.submit": "Bắt đầu",
    "onboarding.privacy": "Hai thông tin này chỉ lưu trong trình duyệt máy bạn, không gửi đi đâu khác. Chưa dựng bảng tính?",
    "onboarding.guide_link": "Xem hướng dẫn cài đặt",

    "loading.eyebrow": "Đang tải",
    "loading.title": "Đang mở sổ từ Google Sheet…",
    "loading.hint0": "Lần đầu trong ngày thường mất vài giây.",
    "loading.hint1": "Vẫn đang chờ Google phản hồi. Lần gọi đầu sau khi triển khai có thể mất tới một phút — đây là bình thường, không phải lỗi.",
    "loading.hint2": "Lâu hơn thường lệ. Nếu quá 2 phút, kiểm tra bản triển khai có đang mở cho “Bất kỳ ai có đường liên kết” không.",

    "fatal.eyebrow": "Không mở được sổ",
    "fatal.retry": "Thử lại",
    "fatal.change_connection": "Đổi kết nối",
    "fatal.old_version_title": "Bảng tính đang chạy mã cũ hơn giao diện",
    "fatal.old_version.p1": "<p><b>Điểm mấu chốt:</b> Apps Script phục vụ <u>phiên bản đã triển khai</u>, không phải code đang nằm trong trình soạn thảo. Dán code mới vào mà không tạo phiên bản mới thì URL vẫn chạy code cũ, và nó không báo lỗi gì cả.</p>",
    "fatal.old_version.p2": "<p>Đang chạy: <b>{{deployed}}</b> · Giao diện cần: <b>v{{expected}}</b></p>",
    "fatal.old_version.deployed_unknown": "bản cũ hơn v3.4",
    "fatal.old_version.p3": "<p>Trong Apps Script, làm đúng thứ tự này:</p>",
    "fatal.old_version.steps": "<p>1. Dán <code>Code.gs</code> mới nhất, bấm <b>lưu</b> (biểu tượng đĩa mềm 💾). Chưa lưu thì bước sau sẽ triển khai lại đúng code cũ.<br>2. <b>Triển khai → Quản lý bản triển khai</b><br>3. Bấm <b>biểu tượng bút chì ✏</b> ở bản triển khai đang dùng<br>4. Ô <b>Phiên bản</b> đang là một con số — đổi thành <b>Phiên bản mới</b><br>5. Bấm <b>Triển khai</b>, rồi quay lại đây bấm <b>Thử lại</b></p>",
    "fatal.old_version.p5": "<p>Nếu bạn có nhiều bảng tính, hãy chắc chắn đã dán code vào đúng cái mà URL này trỏ tới — không thì bấm “Đổi kết nối”.</p>",
    "fatal.load_failed_title": "Chưa tải được dữ liệu",
    "fatal.render_error_title": "Giao diện gặp lỗi khi hiển thị dữ liệu",
    "fatal.render_error_hint": "<p>Thường là do mã <code>Code.gs</code> trên Google Sheet cũ hơn trang này. Dán lại bản mới rồi triển khai với <b>Phiên bản: Mới</b>.</p>",
    "fatal.recurring_generated": "Đã tự ghi {{n}} khoản định kỳ đến hạn.",

    "health.chip.no_data": "Chưa đủ dữ liệu",
    "home.hero.eyebrow": "Tiền có thể dùng",
    "home.hero.blurb_no_data": "Ghi thêm vài giao dịch ở danh mục thiết yếu để tính được sức khỏe tài chính.",
    "home.hero.downgraded_label": "Điểm bị hạ vì:",
    "home.hero.net_worth": "Tổng tài sản {{amount}}",
    "home.hero.runway": "Cầm cự {{months}} kỳ nếu mất thu nhập",
    "home.ribbon.time_label": "Thời gian",
    "home.ribbon.money_label": "Tiền",
    "home.ribbon.budget_word": "ngân sách",
    "home.ribbon.avg_period_word": "mức chi trung bình một kỳ",
    "home.ribbon.no_budget_note": "Đặt ngân sách cho kỳ này để so nhịp tiêu với nhịp thời gian.",
    "home.ribbon.note": "Đã đi {{timePct}}% thời gian của kỳ, đã tiêu {{moneyPct}}% {{label}}.",

    "metric.survival.label": "Cầm cự được",
    "metric.survival.unit_days": "ngày",
    "metric.survival.note_has_data": "với mức chi 30 ngày qua",
    "metric.survival.note_no_data": "chưa có dữ liệu chi",
    "metric.forecast.label": "Dự báo cuối kỳ",
    "metric.forecast.note": "còn {{days}} ngày",
    "metric.savings.label": "Tiết kiệm kỳ này",
    "metric.savings.note_has_data": "phần thu giữ lại được",
    "metric.savings.note_no_data": "chưa ghi thu nhập",
    "metric.concentration.label": "Ngốn tiền nhất",
    "metric.concentration.note_has_data": "{{pct}} chi tiêu kỳ này",
    "metric.concentration.note_no_data": "chưa có chi tiêu",
    "metric.rigidity.label": "Chi cố định",
    "metric.rigidity.note_has_data": "phần thu đã bị khóa cứng",
    "metric.rigidity.note_no_data": "cần lịch sử 3 kỳ",
    "metric.income_stability.label": "Dao động thu nhập",
    "metric.income_stability.note_has_data": "càng thấp càng đều",
    "metric.income_stability.note_no_data": "cần ít nhất 2 kỳ",
    "metric.reliable_income.label": "Thu chắc chắn",
    "metric.reliable_income.note_covered": "đã đủ chi thiết yếu",
    "metric.reliable_income.note_not_covered": "chưa đủ chi thiết yếu",

    "home.budget_reminders.title": "Ngân sách kỳ này",
    "home.budget_reminders.over": "Đã vượt {{amount}}",
    "home.budget_reminders.remaining": "Còn {{amount}} cho {{days}} ngày tới",
    "home.budget_reminders.streak": "Đã {{n}} kỳ liên tiếp không vượt ngân sách.",

    "home.goals_summary.title": "Mục tiêu",
    "home.goals_summary.pursuing": "Đang theo đuổi",
    "home.goals_summary.need_per_period": "Cần dành mỗi kỳ",
    "home.goals_summary.all_on_track": "Tất cả mục tiêu đang đúng tiến độ.",
    "home.goals_summary.behind": "{{count}} mục tiêu đang chậm: {{names}}.",

    "home.event.title": "Sự kiện sắp tới",
    "home.event.today": "hôm nay",
    "home.event.days_left": "còn {{days}} ngày",
    "home.event.owed_suffix": "còn phải trả",
    "home.event.affordable": "Số dư hiện tại thừa sức lo khoản này.",
    "home.event.not_affordable": "Số dư hiện tại chưa đủ cho khoản này — cần dành thêm trước ngày đó.",

    "home.breakdown.title": "Tiền đi đâu kỳ này",
    "home.trend.title": "Tỷ lệ tiết kiệm",
    "home.accounts.title": "Tài khoản",
    "home.accounts.not_liquid_suffix": "không tính vào tiền có thể dùng",
    "home.accounts.empty": "Chưa có tài khoản nào.",

    "home.balance5030.title": "Cân đối 50/30/20",
    "home.balance5030.this_period": "kỳ này",
    "home.balance5030.essential": "Thiết yếu",
    "home.balance5030.optional": "Tùy chọn",
    "home.balance5030.kept": "Còn giữ lại",
    "home.balance5030.reference": "Tham chiếu: khoảng {{pct}}%",
    "home.balance5030.unclassified": "{{amount}} chưa xếp được vào nhóm nào — thêm “thiết yếu/tùy chọn” cho danh mục ở Cài đặt để con số này chính xác hơn.",

    "home.first_run.setup_created": "Đã tự dựng {{n}} tab trong Google Sheet của bạn",
    "home.first_run.seeded_categories": " và nạp sẵn {{n}} danh mục.",
    "home.first_run.period": ".",
    "home.first_run.ready": "Bảng tính đã sẵn sàng.",
    "home.first_run.eyebrow": "Bắt đầu",
    "home.first_run.title": "Sổ của bạn đã sẵn sàng",
    "home.first_run.subtitle": "{{note}} Ghi vài giao dịch là các chỉ số bên dưới bắt đầu có ý nghĩa.",
    "home.first_run.step1": "1. Đặt số dư thật cho từng tài khoản",
    "home.first_run.step2": "2. Ghi giao dịch hằng ngày ở tab Nhập",
    "home.first_run.step3": "3. Đặt ngân sách kỳ này ở tab Kế hoạch",
    "home.first_run.cta_add": "Ghi giao dịch đầu tiên",
    "home.first_run.cta_settings": "Sửa số dư",
    "home.first_run.footnote": "Các chỉ số như số kỳ cầm cự hay tỷ lệ tiết kiệm cần ít nhất một kỳ đã khép lại mới tính được — chúng sẽ tự hiện ra, không cần làm gì thêm.",

    "home.greeting_morning": "Chào buổi sáng ☀️",
    "home.greeting_afternoon": "Chào buổi trưa",
    "home.greeting_evening": "Chào buổi chiều",
    "home.greeting_night": "Chào buổi tối 🌙",
    "home.net_worth_label": "TỔNG TÀI SẢN RÒNG",
    "home.balance_group.liquid": "TIỀN MẶT & NGÂN HÀNG",
    "home.balance_group.ewallet": "VÍ ĐIỆN TỬ",
    "home.balance_group.credit": "THẺ TÍN DỤNG",
    "home.balance_group.savings": "TIẾT KIỆM",
    "home.quick.import": "Nhập ảnh",
    "home.quick.analyze": "Phân tích",
    "home.subs.title": "Đăng ký định kỳ",
    "home.subs.summary": "{{n}} khoản · {{amount}} kỳ này",
    "home.subs.empty": "Chưa có khoản định kỳ nào.",
    "home.subs.due_today": "Hôm nay",
    "home.subs.due_in_days": "{{n}} ngày",
    "home.cashflow.title": "Ngân sách kỳ này",
    "home.cashflow.budget_label": "Ngân sách {{amount}}",
    "home.cashflow.no_budget": "Chưa đặt ngân sách cho kỳ này",
    "home.cashflow.spent_donut_label": "ĐÃ CHI",
    "home.recent_title": "Giao dịch gần đây",
    "home.recent_view_all": "Xem sổ →",
    "home.bell_aria": "Cảnh báo",
    "add.hero_label_out": "TIỀN RA",
    "add.hero_label_in": "TIỀN VÀO",
    "add.hero_label_transfer": "CHUYỂN NỘI BỘ",
    "add.hero_hint": "Gõ nhanh {{a}} · {{b}} · {{c}}",
    "add.source_out": "Trả từ",
    "add.source_in": "Nhận vào",
    "add.source_transfer": "Từ tài khoản",
    "add.nudge_text": "Khoản này khá lớn — <b>mô phỏng tác động</b> trước khi lưu?",

    "home.ai_daily.eyebrow": "Nhận xét hôm nay",
    "home.ai_daily.loading": "Đang đọc số liệu…",

    "ledger.no_match": "Không có giao dịch nào khớp.",
    "ledger.filter.all": "Tất cả",
    "ledger.filter.out": "Chi",
    "ledger.filter.in": "Thu",
    "ledger.filter.transfer": "Chuyển khoản",
    "ledger.search_placeholder": "Tìm theo mô tả, danh mục, tài khoản",
    "ledger.show_more": "Xem thêm {{n}} giao dịch cũ hơn",
    "ledger.show_more_count": "Tải thêm · đang xem {{shown}}/{{total}}",
    "ledger.footnote": "Đang hiển thị {{shown}} giao dịch gần nhất trong tổng số {{total}}. Tải CSV ở Cài đặt để xem toàn bộ.",
    "ledger.transfer_title": "Chuyển khoản",
    "ledger.header_title": "Sổ giao dịch",
    "ledger.header_count": "{{n}} giao dịch",
    "ledger.period_range": "Kỳ {{range}}",
    "ledger.sort_aria": "Đổi thứ tự mới nhất/cũ nhất",
    "ledger.filter.category_all": "Danh mục",
    "ledger.filter.account_all": "Tài khoản",
    "ledger.summary.in": "VÀO",
    "ledger.summary.out": "RA",
    "ledger.summary.net": "CHÊNH",
    "ledger.empty.title": "Không có giao dịch nào khớp",
    "ledger.empty.subtitle": "Thử bỏ một bộ lọc, hoặc đổi từ khóa tìm kiếm.",
    "ledger.empty.reset": "Bỏ hết bộ lọc",
    "ledger.detail.note": "Ghi chú",
    "ledger.detail.source": "Nguồn phân loại",
    "ledger.detail.id": "Mã",
    "ledger.rule.recurring": "Đăng ký định kỳ",
    "ledger.rule.ocr": "AI đề xuất · đã xác nhận",
    "ledger.rule.transfer": "Chuyển nội bộ",
    "ledger.rule.manual": "Chọn tay",
    "ledger.action.duplicate": "Nhân bản",
    "ledger.duplicated": "Đã nhân bản giao dịch vào hôm nay.",

    "add.title": "Ghi một giao dịch",
    "add.amount_label": "Số tiền",
    "add.amount_placeholder": "500k, 1tr, 2tr5…",
    "add.direction_out": "Chi tiền",
    "add.direction_in": "Thu tiền",
    "add.direction_transfer": "Chuyển khoản",
    "add.account_label": "Tài khoản",
    "add.from_account_label": "Từ tài khoản",
    "add.to_account_label": "Đến tài khoản",
    "add.category_label": "Danh mục",
    "add.category_empty_hint": "Để trống là tự phân loại theo luật",
    "add.description_label": "Mô tả",
    "add.description_placeholder": "VD: Ăn trưa Highlands",
    "add.date_label": "Ngày",
    "add.save": "Lưu giao dịch",
    "add.import_title": "Nhập từ ảnh chụp màn hình",
    "add.import_intro": "Chụp màn hình biên lai MoMo / ngân hàng rồi chọn ảnh ở đây — <b>chọn nhiều ảnh một lúc cũng được</b>. Máy đọc ra số tiền và lời nhắn, bạn xem lại rồi mới lưu; không có gì được ghi tự động.",
    "add.import_file_label": "Chọn ảnh (có thể chọn nhiều)",
    "add.recent_title": "Vừa ghi gần đây",
    "add.amount_hint_invalid": "Chưa hiểu số này — thử 500k, 1tr, 2tr5 hoặc 500000.",
    "add.amount_hint_equals": "= {{amount}}",
    "add.error_amount_required": "Nhập số tiền đã nhé — ví dụ 500k, 1tr, hoặc 500000.",
    "add.error_same_account": "Chọn hai tài khoản khác nhau cho lệnh chuyển khoản.",
    "add.confirm_simulate": "Đây là khoản chi lớn ({{amount}}). Mô phỏng tác động trước khi lưu?",
    "add.saved": "Đã lưu {{amount}}.",
    "add.saved_auto_categorised": " Đã tự xếp danh mục theo luật của bạn.",

    "import.no_candidates": "Không đọc được giao dịch nào trong ảnh. Thử ảnh rõ hơn, hoặc nhập tay ở trên.",
    "import.file_unreadable": "Không đọc được file ảnh.",
    "import.file_not_image": "File này không phải ảnh hợp lệ.",
    "import.amount_aria": "Số tiền",
    "import.note_placeholder": "Mô tả",
    "import.note_aria": "Mô tả",
    "import.account_aria": "Tài khoản",
    "import.category_aria": "Danh mục",
    "import.summary": "Đọc được <b>{{n}}</b> giao dịch. Kiểm tra lại rồi bấm lưu — chưa có gì được ghi vào sổ cả.",
    "import.save_button": "Lưu các giao dịch đã chọn",
    "import.progress_count": "{{current}}/{{total}}",
    "import.stage_upload": "Đang tải ảnh lên…",
    "import.stage_read": "Đọc chữ trong ảnh…",
    "import.stage_match": "Đối chiếu với danh mục…",
    "import.found_so_far": "Đã tìm thấy {{n}} giao dịch.",
    "import.no_key": "Tính năng này cần GEMINI_API_KEY trong Script Properties của bảng tính. Chưa có thì cứ nhập tay ở trên.",
    "import.some_failed": "{{failed}}/{{total}} ảnh không đọc được ({{names}}). Các ảnh còn lại vẫn dùng được bên dưới.",
    "import.none_selected": "Chưa chọn giao dịch nào.",
    "import.saved_summary": "Đã lưu {{n}} giao dịch.",
    "import.skipped_duplicate": "{{n}} khoản đã nhập trước đó, bỏ qua.",
    "import.skipped_invalid": "{{n}} khoản không hợp lệ.",

    "plan.hub.title": "Kế hoạch",
    "plan.hub.intro": "Bảy khu vực, từ hạn mức của kỳ này tới dự báo nhiều kỳ tới. Chọn một khu để bắt đầu.",

    "plan.budget.title": "Ngân sách theo kỳ",
    "plan.budget.desc": "Đặt hạn mức cho từng nhóm chi trong kỳ 15 → 14, rồi theo dõi đã tiêu tới đâu.",
    "plan.goals.title": "Mục tiêu tích lũy",
    "plan.goals.desc": "Những khoản cần dành dần qua nhiều kỳ — quỹ khẩn cấp, tiết kiệm, đầu tư.",
    "plan.events.title": "Kế hoạch sự kiện",
    "plan.events.desc": "Chuyến đi, đám cưới, chuyển nhà: ghi trước để nó nằm trong dự báo thay vì ập đến.",
    "plan.income.title": "Nguồn thu",
    "plan.income.desc": "Khai báo từng nguồn kèm độ tin cậy, để biết thu chắc chắn có nuôi nổi chi thiết yếu không.",
    "plan.recurring.title": "Khoản định kỳ",
    "plan.recurring.desc": "Tiền phòng, thuê bao, học phí — đến hạn là app tự ghi thành giao dịch.",
    "plan.forecast.title": "Dự báo dòng tiền",
    "plan.forecast.desc": "Kéo dài nhịp thu chi hiện tại về phía trước, cộng dồn số dư qua từng kỳ.",
    "plan.simulate.title": "Mô phỏng khoản chi lớn",
    "plan.simulate.desc": "Trả ngay, trả góp hay hoãn lại — xem phương án nào làm số dư vỡ, và vỡ vào kỳ nào.",

    "plan.budget.prev_period": "← Kỳ trước",
    "plan.budget.next_period": "Kỳ sau →",
    "plan.budget.current_period_tag": "· kỳ này",
    "plan.budget.total_budget": "Tổng ngân sách",
    "plan.budget.total_spent": "Đã tiêu",
    "plan.budget.goal_context": "Các mục tiêu đang cần thêm {{amount}} mỗi kỳ, ngoài ngân sách chi tiêu ở trên.",
    "plan.budget.per_category_title": "Hạn mức từng danh mục",
    "plan.budget.no_categories": "Chưa có danh mục chi tiêu nào.",
    "plan.budget.spent_hint": "Đã tiêu {{spent}} · {{pct}}",
    "plan.budget.suggested_hint": "Gợi ý từ lịch sử: {{amount}}",
    "plan.budget.no_suggestion": "Chưa có gợi ý",
    "plan.budget.blank_placeholder": "Bỏ trống nếu không đặt",
    "plan.budget.save_button": "Lưu ngân sách kỳ {{period}}",
    "plan.budget.invalid_fields": "Có {{n}} ô số tiền chưa hợp lệ — sửa rồi lưu lại.",
    "plan.budget.none_entered": "Chưa nhập hạn mức nào.",
    "plan.budget.saving_n": "Đang lưu {{n}} hạn mức…",
    "plan.budget.saved": "Đã lưu ngân sách.",

    "plan.goals.active_title": "Mục tiêu đang theo đuổi",
    "plan.goals.none": "Chưa có mục tiêu nào.",
    "plan.goals.ask_ai": "Hỏi AI nên ưu tiên mục tiêu nào",
    "plan.goals.emergency_hint": "Gợi ý quỹ khẩn cấp: {{amount}} (6 kỳ chi phí thiết yếu).",
    "plan.goals.add_title": "Thêm mục tiêu",
    "plan.goals.name_label": "Tên mục tiêu",
    "plan.goals.name_placeholder": "VD: Quỹ khẩn cấp",
    "plan.goals.type_label": "Loại",
    "plan.goals.target_label": "Số tiền đích",
    "plan.goals.target_placeholder": "VD: 20tr",
    "plan.goals.deadline_label": "Hạn chót",
    "plan.goals.account_label": "Tài khoản tích lũy",
    "plan.goals.submit": "Tạo mục tiêu",
    "plan.goals.overdue": "Đã quá hạn",
    "plan.goals.off_track": "Chậm tiến độ",
    "plan.goals.on_track": "Đúng tiến độ",
    "plan.goals.progress_line": "{{status}} · còn {{periods}} kỳ · cần {{amount}} đ/kỳ",
    "plan.goals.tracked_via": "Theo dõi qua tài khoản {{account}} · hạn {{deadline}}",
    "plan.goals.created": "Đã tạo mục tiêu.",
    "plan.goals.hide_confirm": "Ẩn mục tiêu này? Lịch sử vẫn được giữ, chỉ không hiển thị nữa.",

    "plan.events.upcoming_title": "Sự kiện sắp tới",
    "plan.events.none": "Chưa có kế hoạch sự kiện nào.",
    "plan.events.none_hint": "Một chuyến đi, một đám cưới, một lần chuyển nhà — ghi ra trước để nó xuất hiện trong dự báo thay vì ập đến bất ngờ.",
    "plan.events.past_title": "Đã diễn ra",
    "plan.events.days_ago": "Đã diễn ra {{n}} ngày trước",
    "plan.events.today": "Diễn ra hôm nay",
    "plan.events.days_left": "Còn {{n}} ngày · kỳ {{period}}",
    "plan.events.linked_goal_tag": "· đã gắn mục tiêu",
    "plan.events.expected": "Dự kiến",
    "plan.events.actual": "Đã chi thực tế",
    "plan.events.remaining": "Còn phải trả",
    "plan.events.goal_prompt": "Sự kiện này còn {{amount}} và cách đây {{periods}} kỳ. Biến nó thành mục tiêu tích lũy để dành dần mỗi kỳ?",
    "plan.events.goal_prompt_cta": "Tạo mục tiêu cho sự kiện này",
    "plan.events.actual_per_item_title": "Chi thực tế từng khoản",
    "plan.events.item_expected_placeholder": "dự kiến {{amount}}",
    "plan.events.item_no_estimate_placeholder": "chưa ước lượng",
    "plan.events.item_footnote": "Điền số thực tế khi đã chi. Phần chưa trả sẽ được trừ vào dự báo dòng tiền ở đúng kỳ diễn ra.",
    "plan.events.plan_title": "Lên kế hoạch sự kiện",
    "plan.events.name_label": "Tên sự kiện",
    "plan.events.name_placeholder": "VD: Du lịch Đà Nẵng",
    "plan.events.date_label": "Ngày diễn ra",
    "plan.events.template_label": "Dùng mẫu có sẵn",
    "plan.events.template_hint": "Mẫu chỉ gợi ý <b>tên khoản mục</b>, không gợi ý giá — giá phụ thuộc hoàn toàn vào nơi bạn ở và hoàn cảnh.",
    "plan.events.items_title": "Các khoản mục",
    "plan.events.add_item": "+ Thêm khoản mục",
    "plan.events.save": "Lưu kế hoạch",
    "plan.events.item_name_placeholder": "Tên khoản mục",
    "plan.events.item_amount_placeholder": "Số tiền",
    "plan.events.need_one_item": "Thêm ít nhất một khoản mục có tên đã nhé.",
    "plan.events.saved": "Đã lưu kế hoạch sự kiện.",
    "plan.events.delete_confirm": "Xóa kế hoạch sự kiện này cùng toàn bộ khoản mục của nó?",

    "plan.income.reliable_title": "Thu nhập chắc chắn",
    "plan.income.reliable_intro": "Một khoản thu <i>dự kiến</i> không nên được coi là chắc chắn chỉ vì bạn mong nó tới. Độ tin cậy là thứ cho phép app chiết khấu nó lại.",
    "plan.income.reliable_per_period": "Thu chắc chắn mỗi kỳ",
    "plan.income.essential_per_period": "Chi thiết yếu mỗi kỳ",
    "plan.income.margin": "Chênh lệch",
    "plan.income.covered_note": "Thu nhập chắc chắn đã đủ trang trải chi phí thiết yếu — phần còn lại là vùng an toàn của bạn.",
    "plan.income.not_covered_note": "Thu nhập chắc chắn chưa đủ chi thiết yếu. Phần thiếu đang phải bù bằng khoản thu bấp bênh hoặc tiền tiết kiệm.",
    "plan.income.no_data_note": "Thêm nguồn thu bên dưới, và ghi đủ một kỳ chi tiêu ở danh mục thiết yếu, để biết thu nhập chắc chắn có đủ nuôi mức sống hiện tại không.",
    "plan.income.sources_title": "Các nguồn thu",
    "plan.income.none": "Chưa khai báo nguồn thu nào.",
    "plan.income.reliable_per_period_short": "Tính chắc chắn được {{amount}}/kỳ",
    "plan.income.add_title": "Thêm nguồn thu",
    "plan.income.name_label": "Tên nguồn thu",
    "plan.income.name_placeholder": "VD: Lương dạy học",
    "plan.income.expected_label": "Số tiền dự kiến mỗi kỳ",
    "plan.income.expected_placeholder": "VD: 8tr",
    "plan.income.reliability_label": "Độ tin cậy (%)",
    "plan.income.reliability_hint": "100 = gần như chắc chắn nhận được. 40 = việc thời vụ, tháng có tháng không.",
    "plan.income.submit": "Thêm nguồn thu",
    "plan.income.added": "Đã thêm nguồn thu.",
    "plan.income.hide_confirm": "Ẩn nguồn thu này? Các chỉ số sẽ tính lại mà không có nó.",

    "plan.recurring.title_card": "Khoản định kỳ",
    "plan.recurring.hint": "Đến hạn là tự động ghi thành giao dịch, ngay lần mở app kế tiếp.",
    "plan.recurring.none": "Chưa có khoản định kỳ nào.",
    "plan.recurring.next_due": "kế tiếp {{date}}",
    "plan.recurring.add_title": "Thêm khoản định kỳ",
    "plan.recurring.name_label": "Tên",
    "plan.recurring.name_placeholder": "VD: Tiền phòng",
    "plan.recurring.amount_label": "Số tiền",
    "plan.recurring.amount_placeholder": "VD: 3tr",
    "plan.recurring.account_label": "Tài khoản",
    "plan.recurring.category_label": "Danh mục",
    "plan.recurring.frequency_label": "Tần suất",
    "plan.recurring.next_due_label": "Lần đến hạn kế tiếp",
    "plan.recurring.submit": "Thêm khoản định kỳ",
    "plan.recurring.added": "Đã thêm khoản định kỳ.",
    "plan.recurring.stop_confirm": "Ngừng khoản định kỳ này? Các giao dịch đã ghi vẫn giữ nguyên.",
    "plan.recurring.direction_out": "Chi",
    "plan.recurring.direction_in": "Thu",

    "plan.forecast.intro": "Kéo dài mức thu/chi trung bình 3 kỳ gần nhất về phía trước, cộng dồn số dư qua từng kỳ. Đây là phép ngoại suy đơn giản — chưa tính mùa vụ hay biến động bất thường.",
    "plan.forecast.include_goals": "Trừ cả tiền dành cho mục tiêu",
    "plan.forecast.reliable_income_only": "Chỉ tính thu nhập chắc chắn (thay vì trung bình lịch sử)",
    "plan.forecast.events_note": "Sự kiện đã lên kế hoạch luôn được trừ vào đúng kỳ diễn ra.",
    "plan.forecast.run": "Xem dự báo 6 kỳ tới",
    "plan.forecast.computing": "Đang tính…",
    "plan.forecast.no_history": "Chưa có kỳ nào hoàn tất để lấy mức trung bình. Dự báo sẽ có ý nghĩa sau khi bạn ghi hết một kỳ.",
    "plan.forecast.event_cost_tag": "(sự kiện −{{amount}})",
    "plan.forecast.period_row_label": "Kỳ {{period}}",
    "plan.forecast.footnote": "Dựa trên thu {{income}} đ{{income_basis}} và chi {{expense}} đ mỗi kỳ{{goal}}{{event}}.",
    "plan.forecast.basis_reliable": " (thu chắc chắn)",
    "plan.forecast.basis_average": " (trung bình {{n}} kỳ gần nhất)",
    "plan.forecast.goal_note": ", trừ {{amount}} đ cho mục tiêu",
    "plan.forecast.event_note": ", trừ {{amount}} đ cho sự kiện đã lên kế hoạch",

    "plan.simulate.intro": "Xem trước tác động lên số dư trước khi quyết định mua.",
    "plan.simulate.item_label": "Món định mua",
    "plan.simulate.item_placeholder": "VD: Laptop mới",
    "plan.simulate.price_label": "Giá",
    "plan.simulate.price_placeholder": "VD: 25tr",
    "plan.simulate.maintenance_label": "Chi phí nuôi mỗi kỳ (nếu có)",
    "plan.simulate.maintenance_placeholder": "VD: 200k",
    "plan.simulate.run": "Mô phỏng",
    "plan.simulate.error_no_price": "Nhập giá món đồ trước đã.",
    "plan.simulate.total_cost": "Tổng chi phí sở hữu",
    "plan.simulate.current_balance": "Số dư hiện tại",
    "plan.simulate.chart_footnote": "Đường trên là quỹ đạo nếu KHÔNG mua. Bảng dưới so từng phương án.",
    "plan.simulate.ask_ai": "Hỏi AI nên chọn phương án nào",
    "plan.simulate.floor_label": "Đáy: {{amount}}",
    "plan.simulate.compare_tag": " (để so sánh)",
    "plan.simulate.negative_from": "Âm quỹ từ kỳ {{period}} (kỳ thứ {{n}}).",
    "plan.simulate.below_threshold_from": "Tụt dưới mức an toàn từ kỳ {{period}}.",
    "plan.simulate.never_breaks": "Không chạm ngưỡng nguy hiểm trong 12 kỳ tới.",
    "plan.simulate.scenario.none": "Không mua",
    "plan.simulate.scenario.now": "Trả hết ngay",
    "plan.simulate.scenario.installment": "Trả góp {{n}} kỳ",
    "plan.simulate.scenario.delay": "Hoãn {{n}} kỳ rồi trả hết",

    "settings.appearance_title": "Giao diện",
    "settings.appearance_hint": "Sáng hay tối, và bảng màu. Cả hai lưu riêng trên máy này.",
    "settings.language_title": "Ngôn ngữ",
    "settings.language_hint": "Đổi ngay lập tức, không cần tải lại trang. Số tiền vẫn luôn theo định dạng Việt Nam.",
    "settings.connection_title": "Kết nối",
    "settings.connection_hint": "Đang dùng Google Sheet qua Apps Script. Dữ liệu nằm trong tài khoản Google của bạn, không đi qua máy chủ nào khác.",
    "settings.device_link_btn": "Mở sổ trên thiết bị khác",
    "settings.status_title": "Tình trạng bảng tính",
    "settings.status_hint": "Bảng tính tự dựng khi mở lần đầu. Nếu có gì bất thường, bấm kiểm tra để biết chính xác thiếu chỗ nào.",
    "settings.run_health_check": "Kiểm tra thiết lập",
    "settings.run_setup_seed": "Dựng lại tab còn thiếu",
    "settings.code_version": "mã v{{version}}",
    "settings.accounts_title": "Tài khoản",
    "settings.accounts_empty": "Chưa có tài khoản nào.",
    "settings.account_new_name_label": "Tên tài khoản mới",
    "settings.account_new_name_placeholder": "VD: MB Thanh toán",
    "settings.account_type_label": "Loại",
    "settings.account_balance_label": "Số dư ban đầu",
    "settings.account_add": "Thêm tài khoản",
    "settings.account_added": "Đã thêm tài khoản.",
    "settings.categories_title": "Danh mục",
    "settings.category_new_name_label": "Tên danh mục mới",
    "settings.category_new_name_placeholder": "VD: Ăn uống",
    "settings.category_kind_label": "Loại",
    "settings.category_necessity_label": "Thiết yếu hay tùy chọn",
    "settings.category_stability_label": "Cố định hay thay đổi",
    "settings.category_hint": "Hai lựa chọn trên nuôi các chỉ số rủi ro và gợi ý ngân sách — đáng điền cho danh mục chi tiêu.",
    "settings.category_add": "Thêm danh mục",
    "settings.category_added": "Đã thêm danh mục.",
    "settings.rules_title": "Tự động phân loại",
    "settings.rules_hint": "Khi mô tả chứa từ khóa, giao dịch bỏ trống danh mục sẽ tự được xếp vào danh mục tương ứng.",
    "settings.rules_empty": "Chưa có luật nào.",
    "settings.rule_pattern_label": "Từ khóa trong mô tả",
    "settings.rule_pattern_placeholder": "VD: highlands",
    "settings.rule_category_label": "Xếp vào danh mục",
    "settings.rule_add": "Thêm luật",
    "settings.rule_added": "Đã thêm luật.",
    "settings.rule_delete_confirm": "Xóa luật tự động phân loại này?",
    "settings.rule_matched": "→ {{category}} · đã khớp {{n}} lần",
    "settings.data_title": "Dữ liệu của bạn",
    "settings.data_hint": "Tải toàn bộ giao dịch về máy dưới dạng CSV, mở được bằng Excel hay Google Sheets.",
    "settings.export_csv": "Tải CSV",
    "settings.reset_connection": "Xóa kết nối trên máy này",
    "settings.reset_connection_confirm": "Xóa URL và mật khẩu đã lưu trên máy này? Dữ liệu trong Google Sheet không bị ảnh hưởng.",
    "settings.exported_rows": "Đã tải {{n}} giao dịch.",
    "settings.exporting": "Đang chuẩn bị file…",
    "settings.checking_spreadsheet": "Đang kiểm tra bảng tính…",
    "settings.setup_created": "Đã tạo tab: {{names}}.",
    "settings.setup_repaired": "Đã sửa dòng tiêu đề: {{names}}.",
    "settings.setup_seeded": "Đã nạp {{accounts}} tài khoản và {{categories}} danh mục mẫu.",
    "settings.setup_nothing": "Bảng tính đã đầy đủ, không cần thay đổi gì.",
    "settings.health_check_ok_headline": "Mọi thứ đã sẵn sàng.",
    "settings.health_check_fail_headline": "Có mục cần xử lý — xem danh sách bên dưới.",
    "settings.health_check_ok_detail": "ổn",
    "settings.version_notice": "Bảng tính đang chạy <b>v{{deployed}}</b>, bản mới nhất là <b>v{{expected}}</b>. Mọi thứ bạn đang dùng vẫn chạy bình thường — chỉ những tính năng mới nhất là chưa có. Muốn cập nhật thì dán lại <code>Code.gs</code> rồi <b>Triển khai → Quản lý bản triển khai → ✏ → Phiên bản: Mới</b>.",

    "dialog.edit_tx.title": "Sửa giao dịch",
    "dialog.edit_tx.direction_out": "Chi",
    "dialog.edit_tx.direction_in": "Thu",
    "dialog.edit_tx.amount_label": "Số tiền",
    "dialog.edit_tx.date_label": "Ngày",
    "dialog.edit_tx.account_label": "Tài khoản",
    "dialog.edit_tx.category_label": "Danh mục",
    "dialog.edit_tx.description_label": "Mô tả",
    "dialog.edit_tx.learn_rule_label": "Lần sau tự xếp vào danh mục này",
    "dialog.edit_tx.learn_rule_pattern_aria": "Từ khóa nhận dạng",
    "dialog.edit_tx.learn_rule_hint": "Rút gọn thành từ khóa dễ khớp hơn, ví dụ chỉ để “highlands”.",
    "dialog.edit_tx.submit": "Lưu thay đổi",
    "dialog.edit_tx.close_aria": "Đóng",
    "dialog.edit_tx.delete_confirm": "Xóa giao dịch này? Số dư tài khoản sẽ được tính lại.",

    "dialog.edit_account.title": "Sửa tài khoản",
    "dialog.edit_account.name_label": "Tên",
    "dialog.edit_account.type_label": "Loại",
    "dialog.edit_account.balance_label": "Số dư thực tế",
    "dialog.edit_account.balance_hint": "Sửa số dư ở đây là để chỉnh lại cho khớp thực tế, không phải để ghi nhận thu nhập — khoản thu thật thì nên nhập ở tab Nhập.",
    "dialog.edit_account.visibility_label": "Hiển thị",
    "dialog.edit_account.visibility_active": "Đang dùng",
    "dialog.edit_account.visibility_hidden": "Ẩn tài khoản này",
    "dialog.edit_account.submit": "Lưu thay đổi",

    "dialog.event_goal.title": "Tạo mục tiêu cho sự kiện",
    "dialog.event_goal.name_label": "Tên mục tiêu",
    "dialog.event_goal.target_label": "Cần tích lũy",
    "dialog.event_goal.target_hint": "Lấy từ phần còn phải trả của sự kiện.",
    "dialog.event_goal.deadline_label": "Hạn chót",
    "dialog.event_goal.account_label": "Tài khoản tích lũy",
    "dialog.event_goal.split_hint": "Chia đều {{amount}} cho {{periods}} kỳ còn lại là khoảng {{perPeriod}} mỗi kỳ.",
    "dialog.event_goal.submit": "Tạo và gắn vào sự kiện",

    "dialog.connection.title": "Kết nối Google Sheet",
    "dialog.connection.url_label": "Địa chỉ bảng tính",
    "dialog.connection.url_hint": "URL từ Apps Script → Triển khai → Ứng dụng web, kết thúc bằng /exec.",
    "dialog.connection.token_label": "Mã kết nối",
    "dialog.connection.token_hint": "Xem lại ở menu Sổ tài chính → ② Xem mã kết nối trên Google Sheet.",
    "dialog.connection.submit": "Lưu và tải lại",
    "dialog.connection.need_both": "Cần cả URL và mã kết nối.",
    "dialog.connection.bad_url": "URL phải kết thúc bằng /exec. Nếu nó kết thúc bằng /dev thì đó là bản thử nghiệm, không dùng được.",
    "dialog.connection.checking_url": "Đang kiểm tra địa chỉ…",
    "dialog.connection.timeout_warning": "Địa chỉ chưa trả lời sau 20 giây (có thể Apps Script đang khởi động nguội).",
    "dialog.connection.version_warning": "Địa chỉ này đang chạy v{{version}}, bản mới nhất là v{{expected}}.",
    "dialog.connection.too_old_warning": "Địa chỉ này chạy mã cũ hơn v3.4, hoặc chưa triển khai xong.",
    "dialog.connection.still_works": " Vẫn lưu được và app sẽ chạy, chỉ thiếu tính năng mới nhất.",
    "dialog.connection.save_anyway": "Lưu địa chỉ này",

    "dialog.device_link.title": "Mở sổ trên thiết bị khác",
    "dialog.device_link.intro": "Mở đường dẫn này trên điện thoại hay máy khác là vào thẳng sổ, không phải gõ lại gì.",
    "dialog.device_link.copy": "Sao chép đường dẫn",
    "dialog.device_link.warning": "Đường dẫn này <b>chứa mã kết nối</b> — ai có nó là mở được sổ của bạn. Chỉ gửi cho chính mình, đừng đăng công khai hay gửi vào nhóm chat.",
    "dialog.device_link.copied": "Đã sao chép.",
    "dialog.device_link.copy_failed": "Không tự sao chép được — bôi đen ô trên rồi copy tay.",

    "ai.eyebrow": "Gợi ý từ AI",
    "ai.thinking": "Đang phân tích…",
    "ai.no_key": "Chưa gắn GEMINI_API_KEY trong Script Properties nên phần này tạm nghỉ. Mọi tính năng khác vẫn chạy bình thường.",
    "ai.generic_unavailable": "Không gọi được AI lúc này. Thử lại sau nhé.",

    "confirm.hide_goal": "Ẩn mục tiêu này? Lịch sử vẫn được giữ, chỉ không hiển thị nữa.",
    "confirm.stop_recurring": "Ngừng khoản định kỳ này? Các giao dịch đã ghi vẫn giữ nguyên.",
    "confirm.delete_rule": "Xóa luật tự động phân loại này?",
    "confirm.hide_income": "Ẩn nguồn thu này? Các chỉ số sẽ tính lại mà không có nó.",
    "confirm.delete_event": "Xóa kế hoạch sự kiện này cùng toàn bộ khoản mục của nó?",
    "confirm.delete_transaction": "Xóa giao dịch này? Số dư tài khoản sẽ được tính lại.",
    "confirm.reset_connection": "Xóa URL và mật khẩu đã lưu trên máy này? Dữ liệu trong Google Sheet không bị ảnh hưởng.",
  },

  en: {
    "error.network": "Couldn't connect to Apps Script. Check the URL in Settings, and make sure the deployment is set to \"Anyone with the link\".",
    "error.bad_token": "Wrong connection code. Look up the correct one on the Google Sheet: menu Sổ tài chính → ② Xem mã kết nối, then re-enter it in Settings.",
    "error.old_backend": "The spreadsheet is running older code that doesn't have this feature yet. Paste the latest Code.gs and redeploy with “New version”.",
    "error.no_token_set": "The spreadsheet has no connection code yet. Open Apps Script and run the setupEverything function once — it will create and show you one.",
    "error.html_response": "Google returned a web page instead of data. Usually the Web App URL is wrong, the deployment was deleted, or you just deployed and it hasn't taken effect yet — wait about a minute and hit Retry.",
    "error.unreadable_response": "The server's response couldn't be read.",
    "error.unknown_server": "The server returned an unknown error.",

    "common.today": "Today",
    "common.edit": "Edit",
    "common.delete": "Delete",
    "common.hide": "Hide",
    "common.stop": "Stop",
    "common.view_all": "View all",
    "common.manage": "Manage",
    "common.change": "Change",
    "common.close": "Close",
    "common.back": "Back",
    "common.saving": "Saving…",
    "common.checking": "Checking…",
    "common.creating": "Creating…",
    "common.use_suggestion": "Use suggestion",
    "common.all_sections_aria": "All sections",
    "common.uncategorized_placeholder": "— Uncategorized —",
    "common.custom_from_scratch": "— Start from scratch —",
    "common.not_categorized": "No description",
    "common.no_description_row": "No description",
    "common.recurring_tag": "recurring",

    "nav.home": "Home",
    "nav.add": "Add",
    "nav.list": "Ledger",
    "nav.plan": "Plan",
    "nav.settings": "Settings",

    "onboarding.eyebrow": "Last step",
    "onboarding.title": "Connect to your Google Sheet",
    "onboarding.intro": "This page is the interface; your ledger lives in your own Google Sheet. Fill in the two fields below once to link them — the app will remember, and next time it opens straight in.",
    "onboarding.url_label": "Spreadsheet address",
    "onboarding.url_hint": "Get it from Apps Script: <b>Deploy → New deployment → Web app</b>, then copy the URL shown. It ends with <span class=\"num\">/exec</span>.",
    "onboarding.token_label": "Connection code",
    "onboarding.token_placeholder": "e.g. K7RQ-2MXP-9TFA",
    "onboarding.token_hint": "The spreadsheet generates this itself. See it any time from the <b>Sổ tài chính → ② Xem mã kết nối</b> menu on the Google Sheet toolbar.",
    "onboarding.submit": "Get started",
    "onboarding.privacy": "These two values are only stored in your browser, never sent anywhere else. Haven't set up the spreadsheet yet?",
    "onboarding.guide_link": "See the setup guide",

    "loading.eyebrow": "Loading",
    "loading.title": "Opening your ledger from Google Sheets…",
    "loading.hint0": "The first load of the day usually takes a few seconds.",
    "loading.hint1": "Still waiting on Google. The first call right after a deployment can take up to a minute — that's normal, not an error.",
    "loading.hint2": "Longer than usual. If it's been over 2 minutes, check that the deployment is set to “Anyone with the link”.",

    "fatal.eyebrow": "Couldn't open your ledger",
    "fatal.retry": "Retry",
    "fatal.change_connection": "Change connection",
    "fatal.old_version_title": "The spreadsheet is running older code than this interface",
    "fatal.old_version.p1": "<p><b>The key point:</b> Apps Script serves the <u>deployed version</u>, not the code sitting in the editor. Pasting new code without creating a new version means the URL keeps running the old code, and it reports no error at all.</p>",
    "fatal.old_version.p2": "<p>Currently running: <b>{{deployed}}</b> · This interface needs: <b>v{{expected}}</b></p>",
    "fatal.old_version.deployed_unknown": "older than v3.4",
    "fatal.old_version.p3": "<p>In Apps Script, do these steps in order:</p>",
    "fatal.old_version.steps": "<p>1. Paste the latest <code>Code.gs</code>, press <b>save</b> (the floppy-disk icon 💾). If you skip this, the next step redeploys the same old code.<br>2. <b>Deploy → Manage deployments</b><br>3. Click the <b>pencil icon ✏</b> on the active deployment<br>4. The <b>Version</b> field shows a number — change it to <b>New version</b><br>5. Click <b>Deploy</b>, then come back here and press <b>Retry</b></p>",
    "fatal.old_version.p5": "<p>If you have more than one spreadsheet, make sure you pasted the code into the one this URL actually points to — otherwise click “Change connection”.</p>",
    "fatal.load_failed_title": "Couldn't load your data",
    "fatal.render_error_title": "The interface hit an error while displaying your data",
    "fatal.render_error_hint": "<p>This is usually because <code>Code.gs</code> on your Google Sheet is older than this page. Paste in the latest version and redeploy with <b>New version</b>.</p>",
    "fatal.recurring_generated": "Automatically logged {{n}} recurring item(s) that came due.",

    "health.chip.no_data": "Not enough data",
    "home.hero.eyebrow": "Available balance",
    "home.hero.blurb_no_data": "Log a few more transactions in essential categories to calculate your financial health.",
    "home.hero.downgraded_label": "Score lowered because:",
    "home.hero.net_worth": "Net worth {{amount}}",
    "home.hero.runway": "{{months}} periods of runway if income stops",
    "home.ribbon.time_label": "Time",
    "home.ribbon.money_label": "Money",
    "home.ribbon.budget_word": "budget",
    "home.ribbon.avg_period_word": "the average period spend",
    "home.ribbon.no_budget_note": "Set a budget for this period to compare your pace of spending against the pace of time.",
    "home.ribbon.note": "{{timePct}}% of the period's time has passed, {{moneyPct}}% of {{label}} spent.",

    "metric.survival.label": "Days you can last",
    "metric.survival.unit_days": "days",
    "metric.survival.note_has_data": "at the last 30 days' spending pace",
    "metric.survival.note_no_data": "no spending data yet",
    "metric.forecast.label": "End-of-period forecast",
    "metric.forecast.note": "{{days}} days left",
    "metric.savings.label": "This period's savings",
    "metric.savings.note_has_data": "share of income kept",
    "metric.savings.note_no_data": "no income logged yet",
    "metric.concentration.label": "Biggest spender",
    "metric.concentration.note_has_data": "{{pct}} of this period's spending",
    "metric.concentration.note_no_data": "no spending yet",
    "metric.rigidity.label": "Fixed spending",
    "metric.rigidity.note_has_data": "share of income already locked in",
    "metric.rigidity.note_no_data": "needs 3 periods of history",
    "metric.income_stability.label": "Income variability",
    "metric.income_stability.note_has_data": "lower means steadier",
    "metric.income_stability.note_no_data": "needs at least 2 periods",
    "metric.reliable_income.label": "Reliable income",
    "metric.reliable_income.note_covered": "covers essential spending",
    "metric.reliable_income.note_not_covered": "not enough for essential spending",

    "home.budget_reminders.title": "This period's budget",
    "home.budget_reminders.over": "Over by {{amount}}",
    "home.budget_reminders.remaining": "{{amount}} left for the next {{days}} days",
    "home.budget_reminders.streak": "{{n}} periods in a row without going over budget.",

    "home.goals_summary.title": "Goals",
    "home.goals_summary.pursuing": "In progress",
    "home.goals_summary.need_per_period": "Needed per period",
    "home.goals_summary.all_on_track": "All goals are on track.",
    "home.goals_summary.behind": "{{count}} goal(s) falling behind: {{names}}.",

    "home.event.title": "Upcoming event",
    "home.event.today": "today",
    "home.event.days_left": "{{days}} days left",
    "home.event.owed_suffix": "still owed",
    "home.event.affordable": "Your current balance easily covers this.",
    "home.event.not_affordable": "Your current balance isn't enough for this yet — set more aside before that date.",

    "home.breakdown.title": "Where the money went this period",
    "home.trend.title": "Savings rate",
    "home.accounts.title": "Accounts",
    "home.accounts.not_liquid_suffix": "not counted in available balance",
    "home.accounts.empty": "No accounts yet.",

    "home.balance5030.title": "The 50/30/20 balance",
    "home.balance5030.this_period": "this period",
    "home.balance5030.essential": "Essential",
    "home.balance5030.optional": "Optional",
    "home.balance5030.kept": "Kept",
    "home.balance5030.reference": "Reference: around {{pct}}%",
    "home.balance5030.unclassified": "{{amount}} hasn't been sorted into either group yet — mark categories “essential/optional” in Settings to make this number more accurate.",

    "home.first_run.setup_created": "Automatically built {{n}} tab(s) in your Google Sheet",
    "home.first_run.seeded_categories": " and pre-loaded {{n}} categories.",
    "home.first_run.period": ".",
    "home.first_run.ready": "Your spreadsheet is ready.",
    "home.first_run.eyebrow": "Get started",
    "home.first_run.title": "Your ledger is ready",
    "home.first_run.subtitle": "{{note}} Log a few transactions and the numbers below start to mean something.",
    "home.first_run.step1": "1. Set the real balance for each account",
    "home.first_run.step2": "2. Log daily transactions in the Add tab",
    "home.first_run.step3": "3. Set this period's budget in the Plan tab",
    "home.first_run.cta_add": "Log your first transaction",
    "home.first_run.cta_settings": "Edit balances",
    "home.first_run.footnote": "Metrics like runway or savings rate need at least one completed period before they can be calculated — they'll show up on their own, no extra steps needed.",

    "home.greeting_morning": "Good morning ☀️",
    "home.greeting_afternoon": "Good afternoon",
    "home.greeting_evening": "Good evening",
    "home.greeting_night": "Good evening 🌙",
    "home.net_worth_label": "NET WORTH",
    "home.balance_group.liquid": "CASH & BANK",
    "home.balance_group.ewallet": "E-WALLETS",
    "home.balance_group.credit": "CREDIT CARDS",
    "home.balance_group.savings": "SAVINGS",
    "home.quick.import": "Scan receipt",
    "home.quick.analyze": "Analyze",
    "home.subs.title": "Recurring",
    "home.subs.summary": "{{n}} item(s) · {{amount}} this period",
    "home.subs.empty": "No recurring items yet.",
    "home.subs.due_today": "Today",
    "home.subs.due_in_days": "{{n}} days",
    "home.cashflow.title": "This period's budget",
    "home.cashflow.budget_label": "Budget {{amount}}",
    "home.cashflow.no_budget": "No budget set for this period",
    "home.cashflow.spent_donut_label": "SPENT",
    "home.recent_title": "Recent transactions",
    "home.recent_view_all": "See ledger →",
    "home.bell_aria": "Alerts",
    "add.hero_label_out": "EXPENSE",
    "add.hero_label_in": "INCOME",
    "add.hero_label_transfer": "INTERNAL TRANSFER",
    "add.hero_hint": "Quick type {{a}} · {{b}} · {{c}}",
    "add.source_out": "Pay from",
    "add.source_in": "Receive into",
    "add.source_transfer": "From account",
    "add.nudge_text": "That's a big expense — <b>simulate its impact</b> before saving?",

    "home.ai_daily.eyebrow": "Today's take",
    "home.ai_daily.loading": "Reading the numbers…",

    "ledger.no_match": "No matching transactions.",
    "ledger.filter.all": "All",
    "ledger.filter.out": "Expense",
    "ledger.filter.in": "Income",
    "ledger.filter.transfer": "Transfer",
    "ledger.search_placeholder": "Search by description, category, account",
    "ledger.show_more": "Show {{n}} older transactions",
    "ledger.show_more_count": "Load more · showing {{shown}}/{{total}}",
    "ledger.footnote": "Showing the {{shown}} most recent transactions out of {{total}} total. Download the CSV in Settings to see everything.",
    "ledger.transfer_title": "Transfer",
    "ledger.header_title": "Ledger",
    "ledger.header_count": "{{n}} transactions",
    "ledger.period_range": "Period {{range}}",
    "ledger.sort_aria": "Toggle newest/oldest first",
    "ledger.filter.category_all": "Category",
    "ledger.filter.account_all": "Account",
    "ledger.summary.in": "IN",
    "ledger.summary.out": "OUT",
    "ledger.summary.net": "NET",
    "ledger.empty.title": "No matching transactions",
    "ledger.empty.subtitle": "Try dropping a filter, or changing your search term.",
    "ledger.empty.reset": "Clear all filters",
    "ledger.detail.note": "Note",
    "ledger.detail.source": "Classified via",
    "ledger.detail.id": "ID",
    "ledger.rule.recurring": "Recurring subscription",
    "ledger.rule.ocr": "AI suggestion · confirmed",
    "ledger.rule.transfer": "Internal transfer",
    "ledger.rule.manual": "Picked manually",
    "ledger.action.duplicate": "Duplicate",
    "ledger.duplicated": "Transaction duplicated to today.",

    "add.title": "Log a transaction",
    "add.amount_label": "Amount",
    "add.amount_placeholder": "500k, 1tr, 2tr5…",
    "add.direction_out": "Expense",
    "add.direction_in": "Income",
    "add.direction_transfer": "Transfer",
    "add.account_label": "Account",
    "add.from_account_label": "From account",
    "add.to_account_label": "To account",
    "add.category_label": "Category",
    "add.category_empty_hint": "Leave blank to auto-categorize by rule",
    "add.description_label": "Description",
    "add.description_placeholder": "e.g. Lunch at Highlands",
    "add.date_label": "Date",
    "add.save": "Save transaction",
    "add.import_title": "Import from a screenshot",
    "add.import_intro": "Screenshot a MoMo/bank receipt and pick it here — <b>you can select several images at once</b>. The app reads out the amount and note; you review before saving, nothing is recorded automatically.",
    "add.import_file_label": "Choose image(s) — multiple allowed",
    "add.recent_title": "Just logged",
    "add.amount_hint_invalid": "Didn't understand that amount — try 500k, 1tr, 2tr5, or 500000.",
    "add.amount_hint_equals": "= {{amount}}",
    "add.error_amount_required": "Enter an amount first — e.g. 500k, 1tr, or 500000.",
    "add.error_same_account": "Pick two different accounts for a transfer.",
    "add.confirm_simulate": "That's a big expense ({{amount}}). Simulate its impact before saving?",
    "add.saved": "Saved {{amount}}.",
    "add.saved_auto_categorised": " Auto-categorized using your rule.",

    "import.no_candidates": "Couldn't read any transactions in this image. Try a clearer photo, or enter it by hand above.",
    "import.file_unreadable": "Couldn't read the image file.",
    "import.file_not_image": "This file isn't a valid image.",
    "import.amount_aria": "Amount",
    "import.note_placeholder": "Description",
    "import.note_aria": "Description",
    "import.account_aria": "Account",
    "import.category_aria": "Category",
    "import.summary": "Read <b>{{n}}</b> transaction(s). Review them, then save — nothing has been written to your ledger yet.",
    "import.save_button": "Save the selected transactions",
    "import.progress_count": "{{current}}/{{total}}",
    "import.stage_upload": "Uploading image…",
    "import.stage_read": "Reading the text in the image…",
    "import.stage_match": "Matching against your categories…",
    "import.found_so_far": "Found {{n}} transaction(s) so far.",
    "import.no_key": "This feature needs GEMINI_API_KEY set in the spreadsheet's Script Properties. Until then, enter transactions by hand above.",
    "import.some_failed": "{{failed}}/{{total}} image(s) couldn't be read ({{names}}). The rest are still usable below.",
    "import.none_selected": "No transactions selected.",
    "import.saved_summary": "Saved {{n}} transaction(s).",
    "import.skipped_duplicate": "{{n}} already imported before, skipped.",
    "import.skipped_invalid": "{{n}} invalid, skipped.",

    "plan.hub.title": "Plan",
    "plan.hub.intro": "Seven areas, from this period's budget to a forecast several periods out. Pick one to start.",

    "plan.budget.title": "Budget by period",
    "plan.budget.desc": "Set a limit for each spending group in the 15th-to-14th period, then track how much you've spent.",
    "plan.goals.title": "Savings goals",
    "plan.goals.desc": "Amounts you're setting aside gradually over several periods — emergency fund, savings, investment.",
    "plan.events.title": "Event plans",
    "plan.events.desc": "A trip, a wedding, a move: log it ahead of time so it shows up in the forecast instead of arriving as a surprise.",
    "plan.income.title": "Income sources",
    "plan.income.desc": "Declare each source with a reliability score, to see whether your certain income can cover essential spending.",
    "plan.recurring.title": "Recurring items",
    "plan.recurring.desc": "Rent, subscriptions, tuition — the app logs them as transactions automatically when they come due.",
    "plan.forecast.title": "Cashflow forecast",
    "plan.forecast.desc": "Project the current pace of income and spending forward, carrying the balance across each period.",
    "plan.simulate.title": "Simulate a big expense",
    "plan.simulate.desc": "Pay now, pay in installments, or delay — see which option breaks your balance, and when.",

    "plan.budget.prev_period": "← Previous period",
    "plan.budget.next_period": "Next period →",
    "plan.budget.current_period_tag": "· this period",
    "plan.budget.total_budget": "Total budget",
    "plan.budget.total_spent": "Spent so far",
    "plan.budget.goal_context": "Your goals need an extra {{amount}} per period, on top of the spending budget above.",
    "plan.budget.per_category_title": "Limit per category",
    "plan.budget.no_categories": "No expense categories yet.",
    "plan.budget.spent_hint": "Spent {{spent}} · {{pct}}",
    "plan.budget.suggested_hint": "Suggested from history: {{amount}}",
    "plan.budget.no_suggestion": "No suggestion yet",
    "plan.budget.blank_placeholder": "Leave blank for no limit",
    "plan.budget.save_button": "Save the {{period}} budget",
    "plan.budget.invalid_fields": "{{n}} amount field(s) are invalid — fix them and save again.",
    "plan.budget.none_entered": "No limits entered.",
    "plan.budget.saving_n": "Saving {{n}} limit(s)…",
    "plan.budget.saved": "Budget saved.",

    "plan.goals.active_title": "Goals in progress",
    "plan.goals.none": "No goals yet.",
    "plan.goals.ask_ai": "Ask AI which goal to prioritize",
    "plan.goals.emergency_hint": "Suggested emergency fund: {{amount}} (6 periods of essential expenses).",
    "plan.goals.add_title": "Add a goal",
    "plan.goals.name_label": "Goal name",
    "plan.goals.name_placeholder": "e.g. Emergency fund",
    "plan.goals.type_label": "Type",
    "plan.goals.target_label": "Target amount",
    "plan.goals.target_placeholder": "e.g. 20tr",
    "plan.goals.deadline_label": "Deadline",
    "plan.goals.account_label": "Savings account",
    "plan.goals.submit": "Create goal",
    "plan.goals.overdue": "Overdue",
    "plan.goals.off_track": "Off track",
    "plan.goals.on_track": "On track",
    "plan.goals.progress_line": "{{status}} · {{periods}} periods left · needs {{amount}} đ/period",
    "plan.goals.tracked_via": "Tracked via account {{account}} · due {{deadline}}",
    "plan.goals.created": "Goal created.",
    "plan.goals.hide_confirm": "Hide this goal? Its history is kept, it just won't be shown anymore.",

    "plan.events.upcoming_title": "Upcoming events",
    "plan.events.none": "No event plans yet.",
    "plan.events.none_hint": "A trip, a wedding, a move — log it ahead of time so it shows up in the forecast instead of arriving as a surprise.",
    "plan.events.past_title": "Past",
    "plan.events.days_ago": "Happened {{n}} days ago",
    "plan.events.today": "Happening today",
    "plan.events.days_left": "{{n}} days left · period {{period}}",
    "plan.events.linked_goal_tag": "· linked to a goal",
    "plan.events.expected": "Expected",
    "plan.events.actual": "Actually spent",
    "plan.events.remaining": "Still owed",
    "plan.events.goal_prompt": "This event still needs {{amount}} and is {{periods}} periods away. Turn it into a savings goal to set money aside gradually each period?",
    "plan.events.goal_prompt_cta": "Create a goal for this event",
    "plan.events.actual_per_item_title": "Actual spend per item",
    "plan.events.item_expected_placeholder": "expected {{amount}}",
    "plan.events.item_no_estimate_placeholder": "no estimate yet",
    "plan.events.item_footnote": "Fill in the real amount once spent. Whatever's still owed is subtracted from the cashflow forecast in the period the event actually happens.",
    "plan.events.plan_title": "Plan an event",
    "plan.events.name_label": "Event name",
    "plan.events.name_placeholder": "e.g. Đà Nẵng trip",
    "plan.events.date_label": "Event date",
    "plan.events.template_label": "Use a template",
    "plan.events.template_hint": "A template only suggests <b>item names</b>, never a price — price depends entirely on where you live and your own circumstances.",
    "plan.events.items_title": "Line items",
    "plan.events.add_item": "+ Add item",
    "plan.events.save": "Save plan",
    "plan.events.item_name_placeholder": "Item name",
    "plan.events.item_amount_placeholder": "Amount",
    "plan.events.need_one_item": "Add at least one named item first.",
    "plan.events.saved": "Event plan saved.",
    "plan.events.delete_confirm": "Delete this event plan along with all of its items?",

    "plan.income.reliable_title": "Reliable income",
    "plan.income.reliable_intro": "An <i>expected</i> income shouldn't be treated as certain just because you're counting on it. Reliability is what lets the app discount it appropriately.",
    "plan.income.reliable_per_period": "Reliable income per period",
    "plan.income.essential_per_period": "Essential spending per period",
    "plan.income.margin": "Margin",
    "plan.income.covered_note": "Your reliable income already covers essential spending — the rest is your safety margin.",
    "plan.income.not_covered_note": "Your reliable income isn't enough for essential spending yet. The gap is being covered by uncertain income or savings.",
    "plan.income.no_data_note": "Add an income source below, and log a full period of essential spending, to see whether your reliable income can support your current lifestyle.",
    "plan.income.sources_title": "Income sources",
    "plan.income.none": "No income sources declared yet.",
    "plan.income.reliable_per_period_short": "{{amount}}/period counted as reliable",
    "plan.income.add_title": "Add an income source",
    "plan.income.name_label": "Source name",
    "plan.income.name_placeholder": "e.g. Tutoring income",
    "plan.income.expected_label": "Expected amount per period",
    "plan.income.expected_placeholder": "e.g. 8tr",
    "plan.income.reliability_label": "Reliability (%)",
    "plan.income.reliability_hint": "100 = almost certain to arrive. 40 = seasonal work, hit or miss month to month.",
    "plan.income.submit": "Add income source",
    "plan.income.added": "Income source added.",
    "plan.income.hide_confirm": "Hide this income source? Metrics will recalculate without it.",

    "plan.recurring.title_card": "Recurring items",
    "plan.recurring.hint": "Once due, it's logged as a transaction automatically the next time the app opens.",
    "plan.recurring.none": "No recurring items yet.",
    "plan.recurring.next_due": "next {{date}}",
    "plan.recurring.add_title": "Add a recurring item",
    "plan.recurring.name_label": "Name",
    "plan.recurring.name_placeholder": "e.g. Rent",
    "plan.recurring.amount_label": "Amount",
    "plan.recurring.amount_placeholder": "e.g. 3tr",
    "plan.recurring.account_label": "Account",
    "plan.recurring.category_label": "Category",
    "plan.recurring.frequency_label": "Frequency",
    "plan.recurring.next_due_label": "Next due date",
    "plan.recurring.submit": "Add recurring item",
    "plan.recurring.added": "Recurring item added.",
    "plan.recurring.stop_confirm": "Stop this recurring item? Transactions already logged stay as they are.",
    "plan.recurring.direction_out": "Expense",
    "plan.recurring.direction_in": "Income",

    "plan.forecast.intro": "Projects the last 3 periods' average income/expense forward, carrying the balance across each period. This is a simple extrapolation — it doesn't yet account for seasonality or unusual swings.",
    "plan.forecast.include_goals": "Also subtract money set aside for goals",
    "plan.forecast.reliable_income_only": "Only count reliable income (instead of the historical average)",
    "plan.forecast.events_note": "Planned events are always subtracted in the period they actually fall in.",
    "plan.forecast.run": "See the next 6 periods",
    "plan.forecast.computing": "Calculating…",
    "plan.forecast.no_history": "No completed period yet to average from. The forecast will mean something once you've logged a full period.",
    "plan.forecast.event_cost_tag": "(event −{{amount}})",
    "plan.forecast.period_row_label": "Period {{period}}",
    "plan.forecast.footnote": "Based on {{income}} đ of income{{income_basis}} and {{expense}} đ of expense per period{{goal}}{{event}}.",
    "plan.forecast.basis_reliable": " (reliable income)",
    "plan.forecast.basis_average": " (average of the last {{n}} periods)",
    "plan.forecast.goal_note": ", minus {{amount}} đ for goals",
    "plan.forecast.event_note": ", minus {{amount}} đ for planned events",

    "plan.simulate.intro": "Preview the impact on your balance before deciding to buy.",
    "plan.simulate.item_label": "Item you're considering",
    "plan.simulate.item_placeholder": "e.g. New laptop",
    "plan.simulate.price_label": "Price",
    "plan.simulate.price_placeholder": "e.g. 25tr",
    "plan.simulate.maintenance_label": "Upkeep cost per period (if any)",
    "plan.simulate.maintenance_placeholder": "e.g. 200k",
    "plan.simulate.run": "Simulate",
    "plan.simulate.error_no_price": "Enter the item's price first.",
    "plan.simulate.total_cost": "Total cost of ownership",
    "plan.simulate.current_balance": "Current balance",
    "plan.simulate.chart_footnote": "The line above is the trajectory if you DON'T buy it. The table below compares each option.",
    "plan.simulate.ask_ai": "Ask AI which option to pick",
    "plan.simulate.floor_label": "Lowest: {{amount}}",
    "plan.simulate.compare_tag": " (for comparison)",
    "plan.simulate.negative_from": "Balance goes negative from period {{period}} (period {{n}}).",
    "plan.simulate.below_threshold_from": "Drops below the safe threshold from period {{period}}.",
    "plan.simulate.never_breaks": "Doesn't hit the danger threshold within the next 12 periods.",
    "plan.simulate.scenario.none": "Don't buy",
    "plan.simulate.scenario.now": "Pay in full now",
    "plan.simulate.scenario.installment": "{{n}}-period installments",
    "plan.simulate.scenario.delay": "Delay {{n}} periods, then pay in full",

    "settings.appearance_title": "Appearance",
    "settings.appearance_hint": "Light or dark, and a color palette. Both are saved on this device only.",
    "settings.language_title": "Language",
    "settings.language_hint": "Changes instantly, no reload needed. Amounts always stay in Vietnamese formatting.",
    "settings.connection_title": "Connection",
    "settings.connection_hint": "Using a Google Sheet through Apps Script. Your data lives in your own Google account, never passing through any other server.",
    "settings.device_link_btn": "Open on another device",
    "settings.status_title": "Spreadsheet status",
    "settings.status_hint": "The spreadsheet builds itself the first time it opens. If something seems off, run a check to see exactly what's missing.",
    "settings.run_health_check": "Check setup",
    "settings.run_setup_seed": "Rebuild missing tabs",
    "settings.code_version": "code v{{version}}",
    "settings.accounts_title": "Accounts",
    "settings.accounts_empty": "No accounts yet.",
    "settings.account_new_name_label": "New account name",
    "settings.account_new_name_placeholder": "e.g. MB Checking",
    "settings.account_type_label": "Type",
    "settings.account_balance_label": "Starting balance",
    "settings.account_add": "Add account",
    "settings.account_added": "Account added.",
    "settings.categories_title": "Categories",
    "settings.category_new_name_label": "New category name",
    "settings.category_new_name_placeholder": "e.g. Food",
    "settings.category_kind_label": "Kind",
    "settings.category_necessity_label": "Essential or optional",
    "settings.category_stability_label": "Fixed or variable",
    "settings.category_hint": "These two choices feed the risk metrics and budget suggestions — worth filling in for expense categories.",
    "settings.category_add": "Add category",
    "settings.category_added": "Category added.",
    "settings.rules_title": "Auto-categorization",
    "settings.rules_hint": "When a description contains a keyword, a transaction left without a category is sorted into the matching one automatically.",
    "settings.rules_empty": "No rules yet.",
    "settings.rule_pattern_label": "Keyword in description",
    "settings.rule_pattern_placeholder": "e.g. highlands",
    "settings.rule_category_label": "Sort into category",
    "settings.rule_add": "Add rule",
    "settings.rule_added": "Rule added.",
    "settings.rule_delete_confirm": "Delete this auto-categorization rule?",
    "settings.rule_matched": "→ {{category}} · matched {{n}} time(s)",
    "settings.data_title": "Your data",
    "settings.data_hint": "Download every transaction as a CSV, openable in Excel or Google Sheets.",
    "settings.export_csv": "Download CSV",
    "settings.reset_connection": "Remove connection on this device",
    "settings.reset_connection_confirm": "Remove the saved URL and password on this device? Data in the Google Sheet is unaffected.",
    "settings.exported_rows": "Downloaded {{n}} transaction(s).",
    "settings.exporting": "Preparing the file…",
    "settings.checking_spreadsheet": "Checking the spreadsheet…",
    "settings.setup_created": "Created tab(s): {{names}}.",
    "settings.setup_repaired": "Fixed header row(s): {{names}}.",
    "settings.setup_seeded": "Loaded {{accounts}} account(s) and {{categories}} sample categories.",
    "settings.setup_nothing": "The spreadsheet is already complete, nothing to change.",
    "settings.health_check_ok_headline": "Everything's ready.",
    "settings.health_check_fail_headline": "Some items need attention — see the list below.",
    "settings.health_check_ok_detail": "ok",
    "settings.version_notice": "The spreadsheet is running <b>v{{deployed}}</b>; the latest is <b>v{{expected}}</b>. Everything you're using still works fine — only the newest features are missing. To update, paste <code>Code.gs</code> again and <b>Deploy → Manage deployments → ✏ → New version</b>.",

    "dialog.edit_tx.title": "Edit transaction",
    "dialog.edit_tx.direction_out": "Expense",
    "dialog.edit_tx.direction_in": "Income",
    "dialog.edit_tx.amount_label": "Amount",
    "dialog.edit_tx.date_label": "Date",
    "dialog.edit_tx.account_label": "Account",
    "dialog.edit_tx.category_label": "Category",
    "dialog.edit_tx.description_label": "Description",
    "dialog.edit_tx.learn_rule_label": "Auto-categorize this next time",
    "dialog.edit_tx.learn_rule_pattern_aria": "Matching keyword",
    "dialog.edit_tx.learn_rule_hint": "Shorten it to an easier-matching keyword, e.g. just “highlands”.",
    "dialog.edit_tx.submit": "Save changes",
    "dialog.edit_tx.close_aria": "Close",
    "dialog.edit_tx.delete_confirm": "Delete this transaction? The account balance will be recalculated.",

    "dialog.edit_account.title": "Edit account",
    "dialog.edit_account.name_label": "Name",
    "dialog.edit_account.type_label": "Type",
    "dialog.edit_account.balance_label": "Actual balance",
    "dialog.edit_account.balance_hint": "Editing the balance here is for correcting it to match reality, not for logging income — a real deposit should be entered from the Add tab.",
    "dialog.edit_account.visibility_label": "Visibility",
    "dialog.edit_account.visibility_active": "In use",
    "dialog.edit_account.visibility_hidden": "Hide this account",
    "dialog.edit_account.submit": "Save changes",

    "dialog.event_goal.title": "Create a goal for this event",
    "dialog.event_goal.name_label": "Goal name",
    "dialog.event_goal.target_label": "Amount to save",
    "dialog.event_goal.target_hint": "Taken from the event's remaining balance owed.",
    "dialog.event_goal.deadline_label": "Deadline",
    "dialog.event_goal.account_label": "Savings account",
    "dialog.event_goal.split_hint": "Splitting {{amount}} across the remaining {{periods}} periods is about {{perPeriod}} per period.",
    "dialog.event_goal.submit": "Create and link to the event",

    "dialog.connection.title": "Connect to a Google Sheet",
    "dialog.connection.url_label": "Spreadsheet address",
    "dialog.connection.url_hint": "The URL from Apps Script → Deploy → Web app, ending in /exec.",
    "dialog.connection.token_label": "Connection code",
    "dialog.connection.token_hint": "See it again from the Sổ tài chính → ② Xem mã kết nối menu on the Google Sheet.",
    "dialog.connection.submit": "Save and reload",
    "dialog.connection.need_both": "Both a URL and a connection code are required.",
    "dialog.connection.bad_url": "The URL must end in /exec. If it ends in /dev that's the test endpoint, and it won't work.",
    "dialog.connection.checking_url": "Checking the address…",
    "dialog.connection.timeout_warning": "The address didn't respond after 20 seconds (Apps Script may be cold-starting).",
    "dialog.connection.version_warning": "This address is running v{{version}}; the latest is v{{expected}}.",
    "dialog.connection.too_old_warning": "This address is running code older than v3.4, or the deployment isn't finished yet.",
    "dialog.connection.still_works": " It will still save and the app will run, just missing the newest features.",
    "dialog.connection.save_anyway": "Save this address anyway",

    "dialog.device_link.title": "Open on another device",
    "dialog.device_link.intro": "Opening this link on a phone or another computer goes straight into the ledger, no retyping needed.",
    "dialog.device_link.copy": "Copy the link",
    "dialog.device_link.warning": "This link <b>contains your connection code</b> — anyone who has it can open your ledger. Only send it to yourself, never post it publicly or share it in a group chat.",
    "dialog.device_link.copied": "Copied.",
    "dialog.device_link.copy_failed": "Couldn't copy automatically — select the field above and copy it by hand.",

    "ai.eyebrow": "AI suggestion",
    "ai.thinking": "Analyzing…",
    "ai.no_key": "GEMINI_API_KEY isn't set in Script Properties, so this feature is on hold. Everything else still works normally.",
    "ai.generic_unavailable": "Couldn't reach the AI right now. Try again later.",

    "confirm.hide_goal": "Hide this goal? Its history is kept, it just won't be shown anymore.",
    "confirm.stop_recurring": "Stop this recurring item? Transactions already logged stay as they are.",
    "confirm.delete_rule": "Delete this auto-categorization rule?",
    "confirm.hide_income": "Hide this income source? Metrics will recalculate without it.",
    "confirm.delete_event": "Delete this event plan along with all of its items?",
    "confirm.delete_transaction": "Delete this transaction? The account balance will be recalculated.",
    "confirm.reset_connection": "Remove the saved URL and password on this device? Data in the Google Sheet is unaffected.",
  },
};
