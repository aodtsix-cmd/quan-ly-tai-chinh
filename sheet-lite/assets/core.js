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
    return "Không kết nối được với Apps Script. Kiểm tra lại URL trong Cài đặt, và chắc chắn bản deploy đang mở cho \"Anyone with the link\".";
  }
  if (message.indexOf("Sai token") !== -1) {
    return "Sai mã kết nối. Xem lại mã đúng ở Google Sheet: menu Sổ tài chính → ② Xem mã kết nối, rồi nhập lại ở Cài đặt.";
  }
  // A feature the frontend knows about but the deployed Code.gs doesn't yet.
  // The raw text leaks an internal action name and helps nobody.
  if (message.indexOf("Hanh dong khong hop le") !== -1) {
    return "Bảng tính đang chạy bản mã cũ hơn nên chưa có tính năng này. " +
      "Dán lại Code.gs mới nhất rồi triển khai với “Phiên bản: Mới” là dùng được.";
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
  // Leaf-level glyphs. Without these, drilling into a parent shows four tiles
  // wearing the same icon, which is worse than no icon at all - the row stops
  // carrying any information and only the text does any work.
  coffee: '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7 4.5v1.5M10.5 3.5v2.5M14 4.5v1.5"/>',
  basket: '<path d="M4 9h16l-1.6 8.5a2 2 0 0 1-2 1.5H7.6a2 2 0 0 1-2-1.5Z"/><path d="m8.5 9 2-4.5M15.5 9l-2-4.5"/><path d="M10 12.5v3M14 12.5v3"/>',
  fuel: '<path d="M4.5 20V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/><path d="M3.5 20h10"/><path d="M5.5 10h6"/><path d="M13 8.5h2.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V10l-2-2.5"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M10 16.5v-9h2.75a2.75 2.75 0 0 1 0 5.5H10"/>',
  wrench: '<path d="M15.5 3.5a5 5 0 0 0-4.2 7.6L3.8 18.6a1.8 1.8 0 0 0 2.6 2.6l7.5-7.5a5 5 0 0 0 6.1-6.6l-2.8 2.8-2.6-.7-.7-2.6Z"/>',
  cap: '<path d="M12 4.5 2.5 9 12 13.5 21.5 9Z"/><path d="M6.5 11v5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-5"/>',
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
