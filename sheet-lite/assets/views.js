/* =========================================================================
   views.js - pure render functions. Each takes state and returns an HTML
   string; none of them touch the network or hold state of their own, so a
   view can always be re-rendered from scratch after any change.

   Every static UI string goes through App.t(key, vars) or App.label(map,
   key) - see core.js's "language" section for the dictionary and why
   amounts/dates are the deliberate exception (they stay Vietnamese-formatted
   regardless of language, per docs/UI-DESIGN-SPEC.md §6). Because these
   lookups happen INSIDE each render call rather than at file-load time, a
   language switch just needs a re-render to take effect - there is no
   separate "translate the DOM in place" step.

   User-entered data (category/account/goal names, descriptions, rule
   patterns) is never translated - only the UI chrome around it is.
   ========================================================================= */

var App = window.App;

// ------------------------------------------------------------ small pieces

App.track = function (pct, modifier) {
  var width = Math.max(0, Math.min(Number(pct) || 0, 100));
  return '<div class="track"><div class="track-fill ' + (modifier || "") + '" style="width:' + width + '%"></div></div>';
};

App.emptyState = function (text) {
  return '<p class="empty">' + App.esc(text) + "</p>";
};

// Grouped <option> list: parents become <optgroup>, so a long category tree
// stays navigable in a native phone picker.
App.categoryOptions = function (categories, kind, selectedId, placeholder) {
  var pool = categories.filter(function (c) { return c.kind === kind; });
  var byId = {};
  pool.forEach(function (c) { byId[c.id] = c; });

  var parents = pool.filter(function (c) { return !c.parent_id; });
  var used = {};
  var html = placeholder === false ? "" : '<option value="">' + App.esc(placeholder || App.t("common.uncategorized_placeholder")) + "</option>";

  function option(category) {
    used[category.id] = true;
    var selected = String(selectedId) === String(category.id) ? " selected" : "";
    return '<option value="' + App.esc(category.id) + '"' + selected + ">" + App.esc(category.name) + "</option>";
  }

  parents.forEach(function (parent) {
    var children = pool.filter(function (c) { return String(c.parent_id) === String(parent.id); });
    if (children.length === 0) {
      html += option(parent);
      return;
    }
    html += '<optgroup label="' + App.esc(parent.name) + '">' + option(parent);
    children.forEach(function (child) { html += option(child); });
    html += "</optgroup>";
  });

  // Any child whose parent isn't in this kind still needs to be selectable.
  pool.forEach(function (c) { if (!used[c.id]) html += option(c); });
  return html;
};

// The category picker as an icon grid, walked one level of the tree at a
// time. A flat grid of every leaf is forty tiles on a phone screen; showing
// the ten parents and drilling in keeps any one screen scannable, and a
// parent with no children is selected directly rather than opening an empty
// level.
App.categoryGrid = function (categories, kind, selectedId, openParentId) {
  var pool = categories.filter(function (c) { return c.kind === kind; });
  var childrenOf = function (id) {
    return pool.filter(function (c) { return String(c.parent_id || "") === String(id); });
  };

  function tile(category, hasChildren) {
    var selected = String(selectedId || "") === String(category.id);
    return '<button type="button" class="icon-tile' + (hasChildren ? " has-children" : "") + '"' +
      ' data-pick-category="' + App.esc(category.id) + '"' +
      (hasChildren ? ' data-open-parent="' + App.esc(category.id) + '"' : "") +
      ' aria-pressed="' + selected + '">' +
      '<span class="glyph">' + App.icon(App.categoryIconName(category.name)) + "</span>" +
      '<span class="tile-name">' + App.esc(category.name) + "</span>" +
      "</button>";
  }

  var open = openParentId
    ? pool.filter(function (c) { return String(c.id) === String(openParentId); })[0]
    : null;

  if (open) {
    // Inside a parent: the parent itself stays selectable, because "Ăn uống"
    // with no sub-category is a legitimate answer.
    return '<button type="button" class="icon-tile" data-open-parent="" aria-pressed="false">' +
        '<span class="glyph">' + App.icon("back") + "</span>" +
        '<span class="tile-name">' + App.esc(App.t("common.back")) + "</span></button>" +
      tile(open, false) +
      childrenOf(open.id).map(function (child) { return tile(child, false); }).join("");
  }

  var parents = pool.filter(function (c) { return !c.parent_id; });
  var orphans = pool.filter(function (c) {
    return c.parent_id && !parents.some(function (p) { return String(p.id) === String(c.parent_id); });
  });

  return parents.map(function (parent) { return tile(parent, childrenOf(parent.id).length > 0); }).join("") +
    orphans.map(function (c) { return tile(c, false); }).join("");
};

// Which tile should be lit, and what the header chip says, given a chosen id.
App.categoryLabel = function (categories, selectedId) {
  var match = categories.filter(function (c) { return String(c.id) === String(selectedId); })[0];
  if (!match) return "";
  var parent = match.parent_id
    ? categories.filter(function (c) { return String(c.id) === String(match.parent_id); })[0]
    : null;
  return (parent ? parent.name + " · " : "") + match.name;
};

App.accountOptions = function (accounts, selectedId, withBalance) {
  return accounts.map(function (account) {
    var label = account.name + (withBalance ? " · " + App.formatDong(account.balance) : "");
    return '<option value="' + App.esc(account.id) + '"' +
      (String(selectedId) === String(account.id) ? " selected" : "") + ">" +
      App.esc(label) + "</option>";
  }).join("");
};

// Horizontally scrolling pill row - the Nhập screen's neon redesign replaces
// its two account <select>s with this, name-only (no balance: the carousel
// on Nhà and Cài đặt already show balances, and a pill row reads better
// short). `pickAttr` lets one function serve both the source row
// (data-pick-account) and the destination row (data-pick-to-account, always
// tinted purple regardless of transaction type) without duplicating markup.
App.accountChips = function (accounts, selectedId, pickAttr, isDest) {
  return accounts.map(function (account) {
    var selected = String(selectedId || "") === String(account.id);
    return '<button type="button" class="neon-chip' + (isDest ? " is-dest" : "") + '"' +
      " " + pickAttr + '="' + App.esc(account.id) + '" aria-pressed="' + selected + '">' +
      App.esc(account.name) + "</button>";
  }).join("");
};

// ------------------------------------------------------------------ charts

// Inline SVG rather than a charting library: two small shapes are all this
// app needs, and it keeps the page dependency-free and offline-capable.
App.sparkline = function (values) {
  if (!values || values.length < 2) return "";
  var width = 300, height = 40, pad = 3;
  var min = Math.min.apply(null, values);
  var max = Math.max.apply(null, values);
  var span = (max - min) || 1;
  var stepX = (width - pad * 2) / (values.length - 1);

  var points = values.map(function (value, index) {
    var x = pad + index * stepX;
    var y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return [x, y];
  });

  var line = points.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
  var area = line + " L" + points[points.length - 1][0].toFixed(1) + " " + (height - pad) +
    " L" + points[0][0].toFixed(1) + " " + (height - pad) + " Z";
  var last = points[points.length - 1];

  return '<svg class="sparkline" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<path class="spark-area" d="' + area + '"/>' +
    '<path d="' + line + '"/>' +
    '<circle class="spark-end" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.5"/>' +
    "</svg>";
};

// Balance-over-periods line, with a dashed zero line so "the month we run
// out" reads without checking the axis labels.
// opts is optional: { altSeries: number[], color: css-color-string }. altSeries
// draws a second, dashed, muted line on the SAME scale (used by Mô phỏng to
// show "with this expense" against the no-purchase baseline) - min/max spans
// both series so the two stay comparable. color overrides the primary line's
// stroke inline (used to recolor it per scenario's own traffic light,
// something a fixed CSS class can't do).
App.lineChart = function (labels, series, opts) {
  if (!series || series.length < 2) return "";
  opts = opts || {};
  var width = 320, height = 130, padL = 4, padR = 4, padT = 10, padB = 18;
  var values = series.slice();
  var altValues = opts.altSeries || null;
  var allValues = altValues ? values.concat(altValues) : values;
  var min = Math.min.apply(null, allValues.concat([0]));
  var max = Math.max.apply(null, allValues.concat([0]));
  var span = (max - min) || 1;
  var stepX = (width - padL - padR) / (values.length - 1);

  function yFor(value) { return padT + (1 - (value - min) / span) * (height - padT - padB); }
  function pointsFor(vals) { return vals.map(function (value, index) { return [padL + index * stepX, yFor(value)]; }); }
  function lineFor(pts) { return pts.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" "); }

  var points = pointsFor(values);
  var line = lineFor(points);
  var baseY = yFor(Math.max(min, 0));
  var area = line + " L" + points[points.length - 1][0].toFixed(1) + " " + baseY.toFixed(1) +
    " L" + points[0][0].toFixed(1) + " " + baseY.toFixed(1) + " Z";
  var altLine = altValues ? lineFor(pointsFor(altValues)) : "";

  var ticks = labels.map(function (label, index) {
    if (labels.length > 6 && index % 2 === 1) return "";
    var x = padL + index * stepX;
    var anchor = index === 0 ? "start" : (index === labels.length - 1 ? "end" : "middle");
    return '<text class="tick" x="' + x.toFixed(1) + '" y="' + (height - 5) + '" text-anchor="' + anchor + '">' + App.esc(label) + "</text>";
  }).join("");

  var zero = (min < 0 && max > 0)
    ? '<line class="zero-line" x1="' + padL + '" y1="' + yFor(0).toFixed(1) + '" x2="' + (width - padR) + '" y2="' + yFor(0).toFixed(1) + '"/>'
    : "";
  var last = points[points.length - 1];

  return '<svg class="chart" viewBox="0 0 ' + width + " " + height + '" role="img">' +
    '<path class="area" d="' + area + '"' + (opts.color ? ' style="fill:' + opts.color + '"' : "") + "/>" + zero +
    (altLine ? '<path class="series-alt" d="' + altLine + '"/>' : "") +
    '<path class="series" d="' + line + '"' + (opts.color ? ' style="stroke:' + opts.color + '"' : "") + "/>" +
    '<circle class="endpoint" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3"' + (opts.color ? ' style="fill:' + opts.color + '"' : "") + "/>" +
    ticks + "</svg>";
};

// Ring gauge for "% of this period's budget spent" - same hand-rolled-SVG
// rule as every other chart here (App.sparkline/App.lineChart): no CDN.
App.donut = function (pct, color) {
  var clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  var r = 40, c = 2 * Math.PI * r;
  var dash = (c * clamped / 100).toFixed(1) + " " + c.toFixed(1);
  return '<svg width="96" height="96" viewBox="0 0 96 96" style="transform:rotate(-90deg)">' +
    '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(--neon-surface-3)" stroke-width="11"/>' +
    '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="11" ' +
    'stroke-linecap="round" stroke-dasharray="' + dash + '"/></svg>';
};

// ================================================================ dashboard
// Dark Neon redesign of Nhà, ported from a Claude Design handoff
// (design_handoff_finance_dark_neon, 2026-08-04). Scoped to this screen only
// via app.css's "#view-home" ancestor overrides - Sổ/Kế hoạch/Cài đặt keep
// the v3.7 indigo system untouched.
//
// The handoff's own Home screen doesn't include Goals/Events/50-30-20/
// savings-trend - it's a different, tighter curation (net worth, balance
// groups, recurring, this-period budget, recent activity). Recreating it
// faithfully means those sections are no longer ON THIS SCREEN; nothing is
// deleted, they're all still one tap away on Kế hoạch. Flagged here because
// it's a real visibility tradeoff, not something to bury in a diff.
//
// Real data only: the handoff's own mock content (Timo/VCB/SSI balances,
// Spotify/YouTube subscriptions, "tháng 8") is illustrative, not something
// to ship literally - see each render function below for what it maps to.

App.renderAlerts = function (alerts) {
  if (!alerts || alerts.length === 0) return "";
  return alerts.map(function (alert) {
    return '<div class="alert alert-' + App.esc(alert.level) + '" data-alert="' + App.esc(alert.code) + '">' +
      "<p>" + App.esc(alert.message) + "</p>" +
      '<button type="button" class="link" data-dismiss-alert="' + App.esc(alert.code) + '">' + App.esc(App.t("common.close")) + "</button>" +
      "</div>";
  }).join("");
};

App.homeGreeting = function () {
  var h = new Date().getHours();
  if (h < 11) return App.t("home.greeting_morning");
  if (h < 14) return App.t("home.greeting_afternoon");
  if (h < 18) return App.t("home.greeting_evening");
  return App.t("home.greeting_night");
};

App.renderHomeHeader = function (data) {
  var hasAlerts = (data.alerts || []).length > 0;
  return '<div class="neon-header">' +
    '<div class="inline" style="gap:0.7rem">' +
      '<span class="neon-avatar">đ</span>' +
      '<span class="neon-greeting">' + App.esc(App.homeGreeting()) + "</span>" +
    "</div>" +
    '<button type="button" class="neon-bell" id="home-bell" aria-label="' + App.esc(App.t("home.bell_aria")) + '">' +
      App.icon("bell") +
      (hasAlerts ? '<span class="dot"></span>' : "") +
    "</button>" +
  "</div>";
};

// Net worth stays exactly what it already meant elsewhere in the app
// (data.money.net_worth, every active account + investment_assets) - this
// screen just gives it top billing and a hide toggle, masking is a pure
// display concern kept in localStorage, independent of everything else.
App.NET_WORTH_HIDDEN_KEY = "sheet_lite_net_worth_hidden";
App.netWorthHidden = function () { return localStorage.getItem(App.NET_WORTH_HIDDEN_KEY) === "1"; };

App.renderHomeNetWorth = function (data) {
  var hidden = App.netWorthHidden();
  var amount = hidden ? "••••••••••" : App.formatVnd(data.money.net_worth) + "đ";
  return '<div>' +
    '<div class="neon-networth-label">' + App.esc(App.t("home.net_worth_label")) +
      '<button type="button" class="neon-eye" id="home-networth-eye">' + (hidden ? "○" : "◉") + "</button>" +
    "</div>" +
    '<div class="neon-networth-row">' +
      '<span class="neon-networth-amount">' + App.esc(amount) + "</span>" +
    "</div>" +
  "</div>";
};

// Grouped by real account type - the handoff's three demo cards (bank
// balances / e-wallets / a stock portfolio) don't map onto this schema
// (there is no investment tracking yet, see CLAUDE.md's Stage 7 note), so
// groups are built from whatever account TYPES the user actually has,
// dropping a card entirely when nothing of that type exists rather than
// showing an empty stock portfolio nobody asked for.
App.HOME_BALANCE_GROUPS = [
  { types: ["bank", "cash"], labelKey: "home.balance_group.liquid", accent: "var(--neon-green)", tint: "rgba(63,245,165,0.14)", tintBorder: "rgba(63,245,165,0.28)", tintShadow: "rgba(63,245,165,0.45)", bgTint: "#151d1a" },
  { types: ["ewallet"], labelKey: "home.balance_group.ewallet", accent: "var(--neon-purple)", tint: "rgba(177,140,255,0.14)", tintBorder: "rgba(177,140,255,0.28)", tintShadow: "rgba(177,140,255,0.45)", bgTint: "#1d1a22" },
  { types: ["savings"], labelKey: "home.balance_group.savings", accent: "var(--neon-green)", tint: "rgba(63,245,165,0.14)", tintBorder: "rgba(63,245,165,0.28)", tintShadow: "rgba(63,245,165,0.45)", bgTint: "#151d1a" },
  { types: ["credit_card"], labelKey: "home.balance_group.credit", accent: "var(--neon-orange)", tint: "rgba(255,145,66,0.14)", tintBorder: "rgba(255,145,66,0.28)", tintShadow: "rgba(255,145,66,0.45)", bgTint: "#221c16" },
];

App.renderHomeCarousel = function (data) {
  var cards = App.HOME_BALANCE_GROUPS.map(function (group) {
    var accounts = data.accounts.filter(function (a) { return group.types.indexOf(a.type) !== -1; });
    if (accounts.length === 0) return "";
    var total = accounts.reduce(function (sum, a) { return sum + a.balance; }, 0);
    var rows = accounts.map(function (a) {
      return '<div class="neon-carousel-row">' +
        '<span class="neon-carousel-row-name"><span class="neon-mono-tile">' + App.esc(App.initials(a.name)) + "</span>" +
        "<span>" + App.esc(a.name) + "</span></span>" +
        '<span class="neon-carousel-row-amount">' + App.formatVnd(a.balance) + "</span>" +
      "</div>";
    }).join("");
    return '<div class="neon-carousel-card" style="--tint:' + group.bgTint + ";--tint-border:" + group.tintBorder + ";--tint-shadow:" + group.tintShadow + ";--accent:" + group.accent + '">' +
      '<div class="neon-carousel-head">' +
        '<span class="neon-carousel-label">' + App.esc(App.t(group.labelKey)) + "</span>" +
        '<span class="neon-carousel-dot"></span>' +
      "</div>" +
      '<div class="neon-carousel-total">' + App.formatDong(total) + "</div>" +
      '<div class="neon-carousel-rows">' + rows + "</div>" +
    "</div>";
  }).filter(Boolean);
  if (cards.length === 0) return "";
  return '<div class="neon-carousel">' + cards.join("") + "</div>";
};

App.renderHomeQuickBar = function () {
  return '<div class="neon-quickbar">' +
    '<button type="button" class="neon-quick-action" data-goto="add:import">' + App.icon("image") + "<span>" + App.esc(App.t("home.quick.import")) + "</span></button>" +
    '<button type="button" class="fab" data-tab="add">+</button>' +
    '<button type="button" class="neon-quick-action" data-goto="plan:analytics">' + App.icon("chart") + "<span>" + App.esc(App.t("home.quick.analyze")) + "</span></button>" +
  "</div>";
};

// Recurring items ARE this app's subscriptions feature (Định kỳ) - real
// data, no fabricated services. Countdown colour: <=3 days red, <=7 orange,
// else neutral, exactly the handoff's own rule. The progress bar has no
// real analogue (recurring items don't track "how much of the cycle has
// elapsed"), so it's approximated from a typical cycle length per frequency
// - an honest best-effort, not a fabricated precise number.
App.HOME_SUB_CYCLE_DAYS = { weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };

App.renderHomeSubs = function (data) {
  var items = (data.recurring || []).filter(function (r) { return r.direction === "out"; });
  if (items.length === 0) return "";
  var total = items.reduce(function (sum, r) { return sum + r.amount; }, 0);

  var cards = items.map(function (item) {
    var days = App.daysUntil(item.next_due);
    var color = days === null ? "var(--neon-ink-soft)" : days <= 3 ? "var(--neon-red)" : days <= 7 ? "var(--neon-orange)" : "var(--neon-ink-soft)";
    var tint = days === null ? "rgba(139,147,164,0.16)" : days <= 3 ? "rgba(255,107,122,0.15)" : days <= 7 ? "rgba(255,145,66,0.15)" : "rgba(139,147,164,0.16)";
    var dueText = days === null ? "—" : days <= 0 ? App.t("home.subs.due_today") : App.t("home.subs.due_in_days", { n: days });
    var cycle = App.HOME_SUB_CYCLE_DAYS[item.frequency] || 30;
    var pct = days === null ? 100 : Math.max(4, Math.min(100, Math.round(((cycle - days) / cycle) * 100)));
    return '<div class="neon-sub-card">' +
      '<div class="spread" style="align-items:center">' +
        '<span class="neon-mono-tile" style="width:1.875rem;height:1.875rem;border-radius:0.625rem;font-size:0.8125rem;background:' + tint + ";color:" + color + '">' + App.esc(App.initials(item.name)) + "</span>" +
        '<span class="neon-sub-due" style="background:' + tint + ";color:" + color + '">' + App.esc(dueText) + "</span>" +
      "</div>" +
      '<div class="neon-sub-name">' + App.esc(item.name) + "</div>" +
      '<div class="neon-sub-amount">' + App.formatVnd(item.amount) + "đ</div>" +
      '<div class="neon-sub-bar"><div style="width:' + pct + "%;background:" + color + '"></div></div>' +
    "</div>";
  }).join("");

  return '<section class="card">' +
    '<div class="spread" style="align-items:baseline">' +
      "<div><h2>" + App.esc(App.t("home.subs.title")) + "</h2>" +
      '<p class="tiny muted" style="margin-top:0.2rem">' + App.esc(App.t("home.subs.summary", { n: items.length, amount: App.formatDong(total) })) + "</p></div>" +
      '<button type="button" class="link" data-goto="plan:recurring">' + App.esc(App.t("common.view_all")) + "</button>" +
    "</div>" +
    '<div class="neon-subs-strip">' + cards + "</div>" +
  "</section>";
};

// "This period's budget", not the handoff's calendar-month framing - this
// app's whole identity is the 15th-to-14th cycle (see period.py), so a
// literal "tháng 8" port would contradict its own most-repeated invariant.
// Figures come from data.budget_statuses, the exact aggregate already used
// by Kế hoạch → Ngân sách - never recomputed differently in two places.
App.renderHomeCashflow = function (data) {
  var statuses = data.budget_statuses || [];
  var totalBudget = statuses.reduce(function (sum, s) { return sum + s.amount; }, 0);
  var totalSpent = statuses.reduce(function (sum, s) { return sum + s.spent; }, 0);

  if (totalBudget <= 0) {
    return '<section class="card">' +
      "<h2>" + App.esc(App.t("home.cashflow.title")) + "</h2>" +
      '<p class="small muted">' + App.esc(App.t("home.cashflow.no_budget")) + "</p>" +
      '<button type="button" class="secondary small" data-goto="plan:budget">' + App.esc(App.t("common.edit")) + "</button>" +
    "</section>";
  }

  var pct = Math.round((totalSpent / totalBudget) * 100);
  var light = pct < 60 ? "green" : pct < 85 ? "yellow" : "red";
  var color = light === "green" ? "var(--neon-green)" : light === "yellow" ? "var(--neon-orange)" : "var(--neon-red)";
  var tint = light === "green" ? "rgba(63,245,165,0.12)" : light === "yellow" ? "rgba(255,145,66,0.12)" : "rgba(255,107,122,0.12)";

  // Best-effort daily bars from the transactions already in this payload
  // (no new backend call): last 7 calendar days' expense total, excluding
  // transfers. If the loaded page doesn't reach back 7 days (a very active
  // ledger past the default limit), older bars silently read as lower than
  // they really are - a known approximation, not a precise report.
  var today = App.today();
  var todayParts = today.split("-");
  var base = new Date(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2]));
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(base); d.setDate(d.getDate() - i);
    days.push({ iso: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"), dow: d.getDay(), total: 0 });
  }
  var byIso = {}; days.forEach(function (d) { byIso[d.iso] = d; });
  (data.transactions || []).forEach(function (tx) {
    if (tx.is_transfer || tx.direction !== "out") return;
    var iso = App.dateOnly(tx.occurred_at);
    if (byIso[iso]) byIso[iso].total += tx.amount;
  });
  var maxDay = Math.max.apply(null, days.map(function (d) { return d.total; }).concat([1]));
  var dowLabels = { vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"], en: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] }[App.currentLang()] || ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  var bars = days.map(function (d) {
    var ratio = d.total / maxDay;
    var barColor = ratio >= 0.999 && d.total > 0 ? "var(--neon-orange)" : ratio >= 0.5 ? "var(--neon-purple)" : "#2c3140";
    var h = Math.max(3, Math.round(ratio * 44));
    return '<div class="neon-week-col"><div class="neon-week-bar" style="height:' + h + "px;background:" + barColor + '"></div>' +
      '<span class="neon-week-day">' + dowLabels[d.dow] + "</span></div>";
  }).join("");

  return '<section class="card">' +
    '<div class="neon-cashflow-head">' +
      "<div><h2>" + App.esc(App.t("home.cashflow.title")) + "</h2>" +
      '<div class="neon-cashflow-budget">' + App.esc(App.t("home.cashflow.budget_label", { amount: App.formatDong(totalBudget) })) + "</div>" +
      '<div class="neon-cashflow-spent">' + App.formatDong(totalSpent) + "</div>" +
      '<span class="neon-status-pill" style="background:' + tint + ";color:" + color + '"><span class="dot"></span>' + App.esc(App.label("traffic_light", light)) + "</span>" +
      "</div>" +
      '<div class="neon-donut-wrap">' + App.donut(pct, color) +
        '<div class="neon-donut-hole"><span class="neon-donut-pct">' + pct + '%</span><span class="neon-donut-label">' + App.esc(App.t("home.cashflow.spent_donut_label")) + "</span></div>" +
      "</div>" +
    "</div>" +
    '<div class="neon-week">' + bars + "</div>" +
  "</section>";
};

// A single floating-card row (the handoff's own visual signature for a
// glance list), shared by Nhà's "Giao dịch gần đây" and Nhập's own
// "Vừa ghi gần đây" mini-list - both are read-only glances at the same
// shape of data, so one row renderer serves both rather than duplicating
// the direction/transfer/icon logic a second time. Neither list offers
// edit/delete: Sổ ("Xem sổ →"/"Xem tất cả") is one tap away for that.
App.neonRecentRow = function (tx) {
  var isTransfer = tx.is_transfer;
  var color = isTransfer ? "var(--neon-ink-soft)" : (tx.direction === "in" ? "var(--neon-green)" : "var(--neon-red)");
  var sign = isTransfer ? "" : (tx.direction === "in" ? "+" : "−");
  var title = tx.description || tx.category_name || (isTransfer ? App.t("ledger.transfer_title") : App.t("common.no_description_row"));
  var glyph = isTransfer ? "swap" : App.categoryIconName(tx.category_name || title);
  var metaCategory = isTransfer
    ? '<span style="color:var(--neon-ink-soft)">' + App.esc(App.t("ledger.transfer_title")) + "</span>"
    : (tx.category_name ? '<span style="color:var(--neon-orange)">' + App.esc(tx.category_name) + "</span>" : "");
  var metaRest = [tx.account_name, App.dateOnly(tx.occurred_at).slice(5)].filter(Boolean).join(" · ");
  return '<div class="neon-recent-row">' +
    '<span class="neon-recent-icon">' + App.icon(glyph) + "</span>" +
    '<div style="flex:1;min-width:0">' +
      '<div class="neon-recent-title">' + App.esc(title) + "</div>" +
      '<div class="neon-recent-meta">' + metaCategory + (metaCategory ? "<span>·</span>" : "") + '<span class="num">' + App.esc(metaRest) + "</span></div>" +
    "</div>" +
    '<span class="neon-recent-amount" style="color:' + color + '">' + sign + App.formatVnd(tx.amount) + "đ</span>" +
  "</div>";
};

App.renderHomeRecent = function (data) {
  var recent = (data.transactions || []).slice(0, 6);
  if (recent.length === 0) return "";
  var rows = recent.map(App.neonRecentRow).join("");

  return '<section>' +
    '<div class="spread" style="padding:0 0.1rem 0.5rem;align-items:baseline">' +
      "<h2>" + App.esc(App.t("home.recent_title")) + "</h2>" +
      '<button type="button" class="link" data-tab="list">' + App.esc(App.t("home.recent_view_all")) + "</button>" +
    "</div>" +
    '<div class="stack-tight">' + rows + "</div>" +
  "</section>";
};

// First run: the dashboard is a grid of dashes and says nothing useful, so
// lead with what to do instead of what isn't known yet.
App.renderFirstRunCard = function (data) {
  var setupNote = data.auto_setup && data.auto_setup.created.length
    ? App.t("home.first_run.setup_created", { n: data.auto_setup.created.length }) +
      (data.auto_setup.seeded && data.auto_setup.seeded.categories
        ? App.t("home.first_run.seeded_categories", { n: data.auto_setup.seeded.categories })
        : App.t("home.first_run.period"))
    : App.t("home.first_run.ready");

  return '<section class="card">' +
    '<span class="eyebrow">' + App.esc(App.t("home.first_run.eyebrow")) + "</span>" +
    "<h1>" + App.esc(App.t("home.first_run.title")) + "</h1>" +
    '<p class="small muted">' + App.esc(App.t("home.first_run.subtitle", { note: setupNote })) + "</p>" +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("home.first_run.step1")) + "</dt><dd></dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("home.first_run.step2")) + "</dt><dd></dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("home.first_run.step3")) + "</dt><dd></dd></div>" +
    "</dl>" +
    '<div class="button-row">' +
      '<button type="button" data-goto="add">' + App.esc(App.t("home.first_run.cta_add")) + "</button>" +
      '<button type="button" class="secondary" data-goto="settings">' + App.esc(App.t("home.first_run.cta_settings")) + "</button>" +
    "</div>" +
    '<p class="tiny faint">' + App.esc(App.t("home.first_run.footnote")) + "</p>" +
    "</section>";
};

App.renderAccountsCard = function (data) {
  var rows = data.accounts.map(function (account) {
    return '<div class="row">' +
      '<span class="row-icon">' + App.icon(App.ACCOUNT_ICONS[account.type] || "wallet") + "</span>" +
      '<div class="row-main"><span class="row-title">' + App.esc(account.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.label("account_type", account.type)) + "</span></div>" +
      '<div class="row-end"><span class="row-amount">' + App.formatDong(account.balance) + "</span></div>" +
      "</div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.accounts.title")) + "</h2>" +
    '<button type="button" class="link" data-goto="settings">' + App.esc(App.t("common.manage")) + "</button></div>" +
    '<div class="rows">' + (rows || App.emptyState(App.t("home.accounts.empty"))) + "</div></section>";
};

// Ported from FinanceNotifyNeon.dc.html. Opened from Nhà's bell icon, as a
// sub-state of the Home tab (App.state.notificationsOpen) - the same
// pattern App.state.goalDetailId already uses for a screen this app never
// had a route for. There is no backend notifications field and none is
// added: every item here is derived, on every render, from data already in
// the bootstrap payload (recurring due dates, this period's budget_statuses,
// goal deadlines) - so it can never drift from what Nhà/Kế hoạch already
// show, and never needs its own storage or API call.
// The handoff's 4 preference toggles are NOT built: there is nowhere to
// persist them (no notifications settings on the backend), and a toggle
// that resets on reload would be worse than no toggle at all.
// "Read" is real but deliberately session-only (App.state.readNotifications,
// never written to localStorage or the sheet) - tapping a card dims it for
// this visit, matching how alert dismissal already works elsewhere in this
// app (a muted look, not a permanent suppression of a still-true condition).
App.buildNotifications = function (data) {
  var items = [];

  // The bell used to just scroll to the top, where data.alerts already
  // renders as banners - folding them in here too (not just leaving them at
  // the top of Nhà) means repurposing the bell for this richer screen loses
  // nothing that already existed.
  (data.alerts || []).forEach(function (alert) {
    items.push({
      id: "alert-" + alert.code, kind: "alert", glyph: "shield",
      title: App.t(alert.level === "danger" ? "notify.alert_title_danger" : "notify.alert_title_warning"),
      body: alert.message, tag: App.t("notify.tag_alert"), ts: data.period.today,
    });
  });

  (data.recurring || []).forEach(function (item) {
    if (item.direction !== "out") return;
    var days = App.daysUntil(item.next_due);
    if (days === null || days > 3) return;
    items.push({
      id: "sub-" + item.name, kind: "sub", glyph: "repeat",
      title: item.name,
      body: App.t(days <= 0 ? "notify.sub_due_today" : "notify.sub_due_in", { amount: App.formatVnd(item.amount), n: days }),
      tag: App.label("frequency", item.frequency), ts: item.next_due,
    });
  });

  (data.budget_statuses || []).forEach(function (status) {
    if (status.pct_used < 85) return;
    items.push({
      id: "jar-" + status.category_id, kind: "jar", glyph: "wallet",
      title: status.category_name,
      body: App.t(status.over_budget ? "notify.jar_over" : "notify.jar_near", {
        category: status.category_name, amount: App.formatVnd(Math.abs(status.remaining)), pct: Math.round(status.pct_used),
      }),
      tag: App.t("notify.tag_jar"), ts: data.period.today,
    });
  });

  (data.goals || []).forEach(function (goal) {
    if (!goal.is_overdue && !goal.is_off_track && goal.periods_remaining > 1) return;
    items.push({
      id: "goal-" + goal.id, kind: "goal", glyph: "target",
      title: goal.name,
      body: goal.is_overdue
        ? App.t("notify.goal_overdue", { name: goal.name, amount: App.formatVnd(goal.remaining_amount) })
        : App.t("notify.goal_off_track", { name: goal.name, amount: App.formatVnd(goal.required_per_period) }),
      tag: App.t("notify.tag_goal"), ts: goal.deadline,
    });
  });

  items.sort(function (a, b) { return String(a.ts) < String(b.ts) ? -1 : 1; });
  return items;
};

App.NOTIFY_FILTERS = [["all", "notify.filter_all"], ["alert", "notify.filter_alert"], ["sub", "notify.filter_sub"], ["jar", "notify.filter_jar"], ["goal", "notify.filter_goal"]];

App.renderNotifications = function (data) {
  var all = App.buildNotifications(data);
  var filter = App.state.notificationFilter || "all";
  var shown = filter === "all" ? all : all.filter(function (n) { return n.kind === filter; });
  var unreadCount = all.filter(function (n) { return !App.state.readNotifications[n.id]; }).length;

  var pills = App.NOTIFY_FILTERS.map(function (pair) {
    return '<button type="button" class="neon-filter-pill" data-notify-filter="' + pair[0] + '" aria-pressed="' +
      (filter === pair[0]) + '">' + App.esc(App.t(pair[1])) + "</button>";
  }).join("");

  var rows = shown.length === 0
    ? '<div class="neon-ledger-empty"><span class="neon-ledger-empty-icon">' + App.icon("bell") + "</span>" +
      '<div style="font-size:0.844rem;font-weight:700">' + App.esc(App.t("notify.empty_title")) + "</div>" +
      '<div class="tiny muted">' + App.esc(App.t("notify.empty_subtitle")) + "</div></div>"
    : shown.map(function (n) {
        var isRead = !!App.state.readNotifications[n.id];
        var palette = {
          alert: ["var(--neon-red)", "rgba(255,107,122,0.14)"], sub: ["var(--neon-orange)", "rgba(255,145,66,0.14)"],
          jar: ["var(--neon-orange)", "rgba(255,145,66,0.14)"], goal: ["var(--neon-purple)", "rgba(177,140,255,0.14)"],
        }[n.kind];
        return '<button type="button" class="neon-notif-row' + (isRead ? " is-read" : "") + '" data-notify-read="' + App.esc(n.id) + '">' +
          '<span class="neon-ledger-row-icon" style="' + (isRead ? "" : "background:" + palette[1] + ";color:" + palette[0]) + '">' + App.icon(n.glyph) + "</span>" +
          (isRead ? "" : '<span class="neon-notif-dot" style="background:' + palette[0] + '"></span>') +
          '<div style="flex:1;min-width:0;text-align:left">' +
            '<div style="font-size:0.8125rem;font-weight:700">' + App.esc(n.title) + "</div>" +
            '<div class="tiny" style="margin-top:0.1875rem;color:var(--neon-ink-2);line-height:1.4">' + App.esc(n.body) + "</div>" +
            '<div class="tiny muted num" style="margin-top:0.3125rem">' + App.esc(n.tag) + " · " + App.esc(App.formatDayMonth(n.ts)) + "</div>" +
          "</div>" +
        "</button>";
      }).join("");

  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.125rem">' +
      '<button type="button" class="icon-btn" data-notify-back aria-label="' + App.esc(App.t("common.back")) + '">' + App.icon("back") + "</button>" +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("notify.title")) + "</div>" +
        '<div class="tiny muted">' + App.esc(App.t("notify.unread_count", { n: unreadCount })) + "</div>" +
      "</div>" +
    "</div>" +
    '<div class="neon-filter-row">' + pills + "</div>" +
    '<div class="stack-tight">' + rows + "</div>" +
  "</div>";
};

App.renderDashboard = function (data) {
  if (App.state.notificationsOpen) return App.renderNotifications(data);
  if (data.transaction_count === 0) {
    return App.renderFirstRunCard(data) + App.renderAccountsCard(data);
  }
  return App.renderAlerts(data.alerts) +
    App.renderHomeHeader(data) +
    App.renderHomeNetWorth(data) +
    App.renderHomeCarousel(data) +
    App.renderHomeQuickBar() +
    '<section class="ai-panel hidden" id="ai-daily"></section>' +
    App.renderHomeSubs(data) +
    App.renderHomeCashflow(data) +
    App.renderHomeRecent(data);
};

// ================================================================ sổ (list)

// Ported from FinanceLedgerNeon.dc.html (Dark Neon handoff, 2026-08-04). This
// tab is reached directly from the bottom bar in this app's 5-tab shell, not
// pushed from Home the way the handoff assumed, so there is no back-chevron
// header here - title + period range + count carries the same context.
//
// "Nguồn phân loại" (classification source) in the row-detail panel is
// approximated from the one field the backend actually sends per row
// (`source`: manual/recurring/ocr) plus `is_transfer` - there is no
// rule-match flag in the bootstrap payload, so a rule-matched manual entry
// reads as "Chọn tay" the same as a hand-picked one. Real, not hidden: fixing
// it would need a new Code.gs field, which this frontend-only pass doesn't add.
App.LEDGER_SOURCE_LABELS = {
  transfer: ["ledger.rule.transfer", "var(--neon-ink-soft)"],
  recurring: ["ledger.rule.recurring", "var(--neon-orange)"],
  ocr: ["ledger.rule.ocr", "var(--neon-purple)"],
  manual: ["ledger.rule.manual", "var(--neon-ink-soft)"],
};

App.renderLedger = function (data) {
  var all = App.filteredTransactions();
  var shown = all.slice(0, App.state.txLimit);

  var typeFilters = [
    ["all", App.t("ledger.filter.all")], ["out", App.t("ledger.filter.out")],
    ["in", App.t("ledger.filter.in")], ["transfer", App.t("ledger.filter.transfer")],
  ].map(function (pair) {
    return '<button type="button" class="neon-filter-pill" data-filter="' + pair[0] + '" aria-pressed="' +
      (App.state.txFilter === pair[0]) + '">' + App.esc(pair[1]) + "</button>";
  }).join("");

  var categoryChoices = data.categories.filter(function (c) { return c.kind !== "transfer"; });
  var categorySelect = '<select id="tx-category-filter" class="neon-filter-select' +
    (App.state.txCategory ? " is-active" : "") + '" aria-label="' + App.esc(App.t("ledger.filter.category_all")) + '">' +
    '<option value="">' + App.esc(App.t("ledger.filter.category_all")) + "</option>" +
    categoryChoices.map(function (c) {
      return '<option value="' + App.esc(c.id) + '"' + (String(App.state.txCategory) === String(c.id) ? " selected" : "") + ">" +
        App.esc(c.name) + "</option>";
    }).join("") + "</select>";

  var accountSelect = '<select id="tx-account-filter" class="neon-filter-select' +
    (App.state.txAccount ? " is-active" : "") + '" aria-label="' + App.esc(App.t("ledger.filter.account_all")) + '">' +
    '<option value="">' + App.esc(App.t("ledger.filter.account_all")) + "</option>" +
    App.accountOptions(data.accounts, App.state.txAccount, false) + "</select>";

  var sums = all.reduce(function (acc, tx) {
    if (tx.is_transfer) return acc;
    if (tx.direction === "in") acc.income += tx.amount; else acc.expense += tx.amount;
    return acc;
  }, { income: 0, expense: 0 });
  var net = sums.income - sums.expense;

  var summary = '<div class="neon-summary-grid">' +
    '<div><div class="neon-summary-label">' + App.esc(App.t("ledger.summary.in")) + '</div>' +
      '<div class="neon-summary-value" style="color:var(--neon-green)">+' + App.formatVnd(sums.income) + "đ</div></div>" +
    '<div><div class="neon-summary-label">' + App.esc(App.t("ledger.summary.out")) + '</div>' +
      '<div class="neon-summary-value" style="color:var(--neon-red)">−' + App.formatVnd(sums.expense) + "đ</div></div>" +
    '<div><div class="neon-summary-label">' + App.esc(App.t("ledger.summary.net")) + '</div>' +
      '<div class="neon-summary-value">' + (net >= 0 ? "+" : "−") + App.formatVnd(Math.abs(net)) + "đ</div></div>" +
  "</div>";

  var hasActiveFilter = App.state.txFilter !== "all" || App.state.txQuery || App.state.txCategory || App.state.txAccount;
  var body;
  if (shown.length === 0) {
    body = '<div class="neon-ledger-empty">' +
      '<span class="neon-ledger-empty-icon">' + App.icon("search") + "</span>" +
      '<div style="font-size:0.844rem;font-weight:700">' + App.esc(App.t("ledger.empty.title")) + "</div>" +
      '<div class="tiny muted">' + App.esc(App.t("ledger.empty.subtitle")) + "</div>" +
      (hasActiveFilter
        ? '<button type="button" class="neon-action-btn neon-action-edit" style="flex:none;padding:0 1rem;margin-top:0.375rem" data-reset-tx-filters>' +
          App.esc(App.t("ledger.empty.reset")) + "</button>"
        : "") +
    "</div>";
  } else {
    var groups = [];
    var byDate = {};
    shown.forEach(function (tx) {
      var date = App.dateOnly(tx.occurred_at);
      if (!byDate[date]) { byDate[date] = []; groups.push(date); }
      byDate[date].push(tx);
    });
    body = groups.map(function (date) {
      var rows = byDate[date];
      var dayNet = rows.reduce(function (acc, tx) {
        if (tx.is_transfer) return acc;
        return acc + (tx.direction === "in" ? tx.amount : -tx.amount);
      }, 0);
      var rowsHtml = rows.map(function (tx) {
        var isTransfer = tx.is_transfer;
        var color = isTransfer ? "var(--neon-ink-soft)" : (tx.direction === "in" ? "var(--neon-green)" : "var(--neon-red)");
        var sign = isTransfer ? "" : (tx.direction === "in" ? "+" : "−");
        var title = tx.description || tx.category_name || (isTransfer ? App.t("ledger.transfer_title") : App.t("common.no_description_row"));
        var glyph = isTransfer ? "swap" : App.categoryIconName(tx.category_name || title);
        var meta = [tx.account_name, App.formatDayMonth(tx.occurred_at)].filter(Boolean).join(" · ");
        var sourceKey = isTransfer ? "transfer" : (App.LEDGER_SOURCE_LABELS[tx.source] ? tx.source : "manual");
        var sourceLabel = App.LEDGER_SOURCE_LABELS[sourceKey];
        var isOpen = String(App.state.txOpenId) === String(tx.id);
        var canDuplicate = !isTransfer;

        var detail = isOpen
          ? '<div class="neon-ledger-detail">' +
              '<dl class="neon-ledger-detail-box">' +
                '<div class="neon-ledger-detail-row"><dt>' + App.esc(App.t("ledger.detail.note")) + '</dt><dd>' + App.esc(tx.description || "—") + "</dd></div>" +
                '<div class="neon-ledger-detail-row"><dt>' + App.esc(App.t("ledger.detail.source")) + '</dt><dd style="color:' + sourceLabel[1] + '">' + App.esc(App.t(sourceLabel[0])) + "</dd></div>" +
                '<div class="neon-ledger-detail-row"><dt>' + App.esc(App.t("ledger.detail.id")) + '</dt><dd class="num" style="color:var(--neon-ink-dim)">#' + App.esc(tx.id) + "</dd></div>" +
              "</dl>" +
              '<div class="neon-ledger-actions">' +
                '<button type="button" class="neon-action-btn neon-action-edit" data-edit-tx="' + App.esc(tx.id) + '">' + App.esc(App.t("common.edit")) + "</button>" +
                '<button type="button" class="neon-action-btn neon-action-dup"' + (canDuplicate ? ' data-dup-tx="' + App.esc(tx.id) + '"' : " disabled") + ">" + App.esc(App.t("ledger.action.duplicate")) + "</button>" +
                '<button type="button" class="neon-action-btn neon-action-del" data-delete-tx="' + App.esc(tx.id) + '">' + App.esc(App.t("common.delete")) + "</button>" +
              "</div>" +
            "</div>"
          : "";

        return '<div>' +
          '<button type="button" class="neon-ledger-row" data-toggle-tx="' + App.esc(tx.id) + '">' +
            '<span class="neon-ledger-row-icon">' + App.icon(glyph) + "</span>" +
            '<div style="flex:1;min-width:0">' +
              '<div class="neon-ledger-row-title">' + App.esc(title) + "</div>" +
              '<div class="neon-ledger-row-meta"><span class="num">' + App.esc(meta) + "</span></div>" +
            "</div>" +
            '<span class="neon-ledger-row-amount" style="color:' + color + '">' + sign + App.formatVnd(tx.amount) + "đ</span>" +
          "</button>" + detail +
        "</div>";
      }).join("");

      return '<div>' +
        '<div class="neon-day-head"><span class="neon-day-label">' + App.esc(App.formatDateHeading(date)) + '</span>' +
          '<span class="neon-day-total num">' + (dayNet >= 0 ? "+" : "−") + App.formatVnd(Math.abs(dayNet)) + "đ</span></div>" +
        '<div class="neon-ledger-card">' + rowsHtml + "</div>" +
      "</div>";
    }).join("");
  }

  var footer = all.length > shown.length
    ? '<button type="button" class="secondary" id="show-more">' +
      App.esc(App.t("ledger.show_more_count", { shown: shown.length, total: data.transaction_count })) + "</button>"
    : (data.transaction_count > data.transactions.length
      ? '<p class="tiny faint">' + App.esc(App.t("ledger.footnote", { shown: data.transactions.length, total: data.transaction_count })) + "</p>"
      : "");

  return '<div style="display:flex;flex-direction:column;gap:0.625rem">' +
    '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.125rem 0.125rem 0">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("ledger.header_title")) + "</div>" +
        '<div class="tiny muted" style="margin-top:0.125rem">' + App.esc(App.t("ledger.period_range", { range: App.formatPeriodRange(data.period) })) +
          " · " + App.esc(App.t("ledger.header_count", { n: all.length })) + "</div>" +
      "</div>" +
      '<button type="button" class="icon-btn" id="tx-sort-toggle" aria-label="' + App.esc(App.t("ledger.sort_aria")) + '">' + App.icon("sort") + "</button>" +
    "</div>" +
    '<div class="neon-search">' + App.icon("search") +
      '<input type="text" id="tx-search" placeholder="' + App.esc(App.t("ledger.search_placeholder")) + '" value="' + App.esc(App.state.txQuery) + '">' +
      (App.state.txQuery ? '<button type="button" class="neon-search-clear" id="tx-search-clear">×</button>' : "") +
    "</div>" +
    '<div class="neon-filter-row">' + typeFilters + '<span class="neon-filter-divider"></span>' + categorySelect + accountSelect + "</div>" +
    summary + body + (footer ? footer : "") +
  "</div>";
};

// ============================================================ kế hoạch (plan)

// Each planning section gets an icon, a title and one line saying what
// question it answers. Without it the tab is a row of chips above a bare
// form, and nothing on screen tells you why you'd open "Định kỳ" over
// "Dự báo" - which is exactly how it read before.
// Values are i18n KEYS, not literal text, so a language switch just needs a
// re-render (planHeader/renderPlanHub call App.t on these at render time).
App.PLAN_META = {
  analytics: ["pie", "plan.analytics.title", "plan.analytics.desc"],
  budget: ["wallet", "plan.budget.title", "plan.budget.desc"],
  goals: ["target", "plan.goals.title", "plan.goals.desc"],
  events: ["calendar", "plan.events.title", "plan.events.desc"],
  income: ["salary", "plan.income.title", "plan.income.desc"],
  recurring: ["repeat", "plan.recurring.title", "plan.recurring.desc"],
  forecast: ["chart", "plan.forecast.title", "plan.forecast.desc"],
  simulate: ["scale", "plan.simulate.title", "plan.simulate.desc"],
};

App.planHeader = function (section) {
  var meta = App.PLAN_META[section];
  if (!meta) return "";
  return '<section class="card">' +
    '<div class="inline" style="gap:0.75rem;flex-wrap:nowrap">' +
      '<span class="metric-icon" style="width:2.5rem;height:2.5rem;flex:none">' + App.icon(meta[0]) + "</span>" +
      "<div><h1>" + App.esc(App.t(meta[1])) + "</h1>" +
      '<p class="small muted">' + App.esc(App.t(meta[2])) + "</p></div>" +
    "</div></section>";
};

// The landing state of the Kế hoạch tab. The sub-nav is a seven-chip row that
// scrolls, and on a 320px screen three of those chips sit off the edge - there
// is nothing telling you Dự báo or Mô phỏng exist at all. A grid shows all
// seven at once. Deep links from the dashboard (data-goto="plan:budget") jump
// straight past this, so the daily path is not made any longer.
App.renderPlanHub = function () {
  var tiles = App.PLAN_SECTIONS.map(function (pair) {
    var meta = App.PLAN_META[pair[0]];
    return '<button type="button" class="hub-tile" data-plan-section="' + pair[0] + '">' +
      '<span class="glyph">' + App.icon(meta[0]) + "</span>" +
      "<b>" + App.esc(App.label("plan_section", pair[0])) + "</b>" +
      "<small>" + App.esc(App.t(meta[2]).split(/[.!?]/)[0]) + "</small>" +
      "</button>";
  }).join("");

  return '<section class="card">' +
    "<h1>" + App.esc(App.t("plan.hub.title")) + "</h1>" +
    '<p class="small muted">' + App.esc(App.t("plan.hub.intro")) + "</p>" +
    '<div class="hub-grid">' + tiles + "</div>" +
    "</section>";
};

// Ported from FinanceAnalyticsNeon.dc.html. Two real gaps versus the
// handoff, both left out rather than faked:
// - No Tuần/Tháng/Năm (week/month/year) range picker. This app's one
//   organising unit is the 15th-14th financial period, never a calendar
//   week/month/year - adding calendar ranges here would contradict that
//   invariant everywhere else in the app. "Kỳ này" is the only range.
// - No "so với kỳ trước" % arrow and no "Nơi tiền đi" (merchant) card.
//   The 6-bar trend only has COMPLETED periods (getPeriodFlows_ excludes
//   the current one), so comparing it against the CURRENT, still-partial
//   period would compare a full period to a partial one - misleading, not
//   just cosmetically different. And there is no merchant/payee field
//   distinct from free-text description to group a "Nơi tiền đi" list by.
// - No AI insight card: no Code.gs prompt exists yet for this task.
App.renderAnalyticsPlan = function (data) {
  var m = data.metrics;
  var totalOut = (m.concentration && m.concentration.has_data) ? m.concentration.total : 0;
  var income = (m.balance_50_30_20 && m.balance_50_30_20.has_data) ? m.balance_50_30_20.income : 0;
  var net = income - totalOut;

  var hero = '<div class="neon-analytics-hero">' +
    '<div class="neon-analytics-hero-label">' + App.esc(App.t("plan.analytics.total_out")) + "</div>" +
    '<div class="neon-analytics-hero-amount">' + App.formatVnd(totalOut) + "đ</div>" +
    '<div class="neon-summary-grid" style="margin-top:1rem;background:transparent;border:0;padding:0">' +
      '<div><div class="neon-summary-label">' + App.esc(App.t("ledger.summary.in")) + '</div>' +
        '<div class="neon-summary-value" style="color:var(--neon-green)">+' + App.formatVnd(income) + "đ</div></div>" +
      '<div><div class="neon-summary-label">' + App.esc(App.t("ledger.summary.out")) + '</div>' +
        '<div class="neon-summary-value" style="color:var(--neon-red)">−' + App.formatVnd(totalOut) + "đ</div></div>" +
      '<div><div class="neon-summary-label">' + App.esc(App.t("plan.analytics.saved")) + '</div>' +
        '<div class="neon-summary-value">' + (net >= 0 ? "+" : "−") + App.formatVnd(Math.abs(net)) + "đ</div></div>" +
    "</div>" +
  "</div>";

  var periods = (m.savings_trend && m.savings_trend.periods) || [];
  var maxFlow = periods.reduce(function (max, p) { return Math.max(max, p.income, p.expense); }, 0);
  var chart = '<div class="card">' +
    '<div class="spread" style="align-items:center">' +
      '<h2 style="margin:0">' + App.esc(App.t("plan.analytics.chart_title")) + "</h2>" +
      '<div style="display:flex;gap:0.75rem;font-size:0.66rem;font-weight:600;color:var(--neon-ink-soft)">' +
        '<span style="display:flex;align-items:center;gap:0.3rem"><span style="width:0.5rem;height:0.5rem;border-radius:2px;background:var(--neon-green)"></span>' + App.esc(App.t("ledger.summary.in")) + "</span>" +
        '<span style="display:flex;align-items:center;gap:0.3rem"><span style="width:0.5rem;height:0.5rem;border-radius:2px;background:var(--neon-red)"></span>' + App.esc(App.t("ledger.summary.out")) + "</span>" +
      "</div>" +
    "</div>" +
    (periods.length === 0
      ? '<p class="tiny muted" style="margin-top:0.75rem">' + App.esc(App.t("plan.analytics.no_history")) + "</p>"
      : '<div class="neon-analytics-chart">' + periods.map(function (p) {
          var inH = maxFlow > 0 ? Math.max(2, Math.round(p.income / maxFlow * 100)) : 2;
          var outH = maxFlow > 0 ? Math.max(2, Math.round(p.expense / maxFlow * 100)) : 2;
          return '<div class="neon-analytics-bar-col">' +
            '<div class="neon-analytics-bar-pair">' +
              '<span class="neon-analytics-bar" style="height:' + inH + '%;background:var(--neon-green)"></span>' +
              '<span class="neon-analytics-bar" style="height:' + outH + '%;background:var(--neon-red)"></span>' +
            "</div>" +
            '<span class="num" style="font-size:0.625rem;font-weight:600;color:var(--neon-ink-dim)">' + App.esc(String(p.period_id).slice(5)) + "</span>" +
          "</div>";
        }).join("") + "</div>") +
  "</div>";

  var breakdown = (m.concentration && m.concentration.has_data) ? m.concentration.breakdown.slice(0, 6) : [];
  var catColors = ["var(--neon-red)", "var(--neon-orange)", "var(--neon-purple)", "var(--neon-green)", "var(--neon-ink-soft)", "var(--neon-ink-dim)"];
  var categories = '<div class="card">' +
    "<h2>" + App.esc(App.t("plan.analytics.category_title")) + "</h2>" +
    (breakdown.length === 0
      ? '<p class="tiny muted">' + App.esc(App.t("plan.analytics.no_history")) + "</p>"
      : '<div class="stack-tight" style="margin-top:0.5rem">' + breakdown.map(function (c, i) {
          var glyph = App.categoryIconName(c.category_name);
          var color = catColors[i % catColors.length];
          return '<div style="display:flex;align-items:center;gap:0.625rem">' +
            '<span class="neon-recent-icon">' + App.icon(glyph) + "</span>" +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem">' +
                '<span style="font-size:0.78rem;font-weight:600">' + App.esc(c.category_name) + "</span>" +
                '<span class="num" style="font-size:0.78rem;font-weight:700">' + App.formatVnd(c.amount) + "đ</span>" +
              "</div>" +
              '<div style="margin-top:0.375rem;display:flex;align-items:center;gap:0.5rem">' +
                '<div style="flex:1;height:0.375rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden">' +
                  '<div style="height:100%;border-radius:999px;background:' + color + ";width:" + Math.round(c.pct) + '%"></div></div>' +
                '<span class="num" style="flex:none;font-size:0.656rem;font-weight:600;color:var(--neon-ink-soft);width:2rem;text-align:right">' + Math.round(c.pct) + "%</span>" +
              "</div>" +
            "</div>" +
          "</div>";
        }).join("") + "</div>") +
  "</div>";

  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="padding:0.125rem">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("plan.analytics.title")) + "</div>" +
      '<div class="tiny muted" style="margin-top:0.125rem">' + App.esc(App.t("ledger.period_range", { range: App.formatPeriodRange(data.period) })) + "</div>" +
    "</div>" +
    hero + chart + categories +
  "</div>";
};

// Ported from FinanceBudgetNeon.dc.html. Two real gaps, left out rather
// than faked:
// - No per-jar source tag (THỦ CÔNG/CỐ ĐỊNH/BIẾN ĐỔI/AI NẮN). Sheet-lite's
//   PERIOD_BUDGETS sheet only has id/category_id/period_id/amount - there is
//   no `source` column at all (unlike the Flask app's table), so this isn't
//   a "data exists, just not exposed" case; adding it is a real schema
//   migration (header repair, actionSetup_, the write path), out of scope
//   for a frontend-only pass.
// - No "Gợi ý hạn mức" batch AI-suggest-then-confirm-each flow. The
//   existing per-category "Dùng gợi ý này" link (already wired to
//   data-apply-suggestion) does the same job one category at a time and is
//   kept as-is, just reskinned - inventing the richer batch flow's own
//   preview/confirm state machine wasn't worth the risk for a visual pass.
// The dual-bar "dải kỳ" pace comparison only means something for the
// CURRENT period (days-elapsed of a period you're not in is meaningless),
// so it's gated on data.period.is_current the same way the hero card is.
App.renderBudgetPlan = function (data) {
  var expenseCategories = data.categories.filter(function (c) { return c.kind === "expense"; });
  var budgetByCategory = {};
  data.budget_statuses.forEach(function (status) { budgetByCategory[status.category_id] = status; });

  var totalBudget = data.budget_statuses.reduce(function (sum, s) { return sum + s.amount; }, 0);
  var totalSpent = data.budget_statuses.reduce(function (sum, s) { return sum + s.spent; }, 0);
  var goalPerPeriod = data.goals.reduce(function (sum, g) { return g.is_overdue ? sum : sum + g.required_per_period; }, 0);

  var periodNav = '<div class="spread" style="padding:0.125rem">' +
    '<button type="button" class="icon-btn" data-period-shift="-1" aria-label="' + App.esc(App.t("plan.budget.prev_period")) + '">‹</button>' +
    '<div style="text-align:center">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("plan.budget.title")) + "</div>" +
      '<div class="tiny muted num">' + App.esc(App.formatPeriodRange(data.period)) +
        (data.period.is_current ? " · " + App.esc(App.t("plan.budget.current_tag")) : "") + "</div>" +
    "</div>" +
    '<button type="button" class="icon-btn" data-period-shift="1" aria-label="' + App.esc(App.t("plan.budget.next_period")) + '">›</button>' +
  "</div>";

  var hero = "";
  if (totalBudget > 0) {
    var remaining = totalBudget - totalSpent;
    var daysRemaining = data.period.is_current ? data.period.days_remaining : 0;
    var perDay = daysRemaining > 0 ? Math.max(0, Math.round(remaining / daysRemaining)) : null;
    var remColor = remaining < 0 ? "var(--neon-red)" : remaining < totalBudget * 0.15 ? "var(--neon-orange)" : "var(--neon-green)";

    var pace = "";
    if (data.period.is_current && data.period.days_total > 0) {
      var elapsedPct = Math.round(data.period.days_elapsed / data.period.days_total * 100);
      var spentPct = Math.round(totalSpent / totalBudget * 100);
      var gap = elapsedPct - spentPct;
      var under = gap >= 0;
      var paceColor = under ? "var(--neon-green)" : "var(--neon-orange)";
      pace = '<div style="margin-top:1rem;display:flex;flex-direction:column;gap:0.3125rem">' +
        '<div class="spread tiny" style="font-weight:600;color:var(--neon-ink-soft)"><span>' + App.esc(App.t("plan.budget.time_elapsed")) + '</span><span class="num" style="color:var(--neon-ink-2)">' + elapsedPct + "%</span></div>" +
        '<div style="height:0.75rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden"><div style="height:100%;border-radius:999px;background:var(--neon-ink-faint);width:' + Math.min(100, elapsedPct) + '%"></div></div>' +
        '<div style="height:0.75rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden"><div style="height:100%;border-radius:999px;background:' + paceColor + ";width:" + Math.min(100, spentPct) + '%"></div></div>' +
        '<div class="spread tiny" style="font-weight:600;color:var(--neon-ink-soft)"><span>' + App.esc(App.t("plan.budget.spent_so_far")) + '</span><span class="num" style="color:var(--neon-ink-2)">' + spentPct + "%</span></div>" +
        '<div style="margin-top:0.5rem;padding-top:0.75rem;border-top:1px solid var(--neon-line);display:flex;align-items:baseline;gap:0.5rem;font-size:0.78rem">' +
          '<b style="color:' + paceColor + '">' + App.esc(App.t(under ? "plan.budget.pace_under" : "plan.budget.pace_over", { n: Math.abs(gap) })) + "</b>" +
          '<span style="color:var(--neon-ink-soft)">' + App.esc(App.t(under ? "plan.budget.pace_under_detail" : "plan.budget.pace_over_detail")) + "</span>" +
        "</div>" +
      "</div>";
    }

    hero = '<div class="card">' +
      '<div class="spread" style="align-items:flex-end">' +
        '<div><div class="neon-summary-label">' + App.esc(App.t("plan.budget.remaining")) + '</div>' +
          '<div style="margin-top:0.375rem;font-family:var(--font-num);font-variant-numeric:tabular-nums;font-size:1.875rem;font-weight:700;letter-spacing:-0.02em;color:' + remColor + '">' +
            (remaining < 0 ? "−" : "") + App.formatVnd(Math.abs(remaining)) + "đ</div></div>" +
        (perDay !== null
          ? '<div style="text-align:right"><div class="num" style="font-size:0.8125rem;font-weight:700">' + App.formatVnd(perDay) + "đ</div>" +
            '<div class="tiny muted">' + App.esc(App.t("plan.budget.per_day_left")) + "</div></div>"
          : "") +
      "</div>" + pace +
    "</div>";
  }

  var rows = expenseCategories.map(function (category) {
    var status = budgetByCategory[category.id];
    var suggestion = data.budget_suggestions[category.id];
    var value = status ? status.amount : "";
    var glyph = App.categoryIconName(category.name);

    var jarTop;
    if (status) {
      var over = status.over_budget;
      var near = status.pct_used >= 85;
      var color = over ? "var(--neon-red)" : near ? "var(--neon-orange)" : "var(--neon-green)";
      var diff = status.amount - status.spent;
      var leftLabel = over
        ? App.t("plan.budget.jar_over", { amount: App.formatVnd(-diff) })
        : App.t("plan.budget.jar_left", { amount: App.formatVnd(diff) });
      var note = over ? App.t("plan.budget.jar_note_over") : near ? App.t("plan.budget.jar_note_near") : App.t("plan.budget.jar_note_ok");
      jarTop = '<div style="flex:1;min-width:0">' +
          '<div class="spread" style="align-items:baseline"><span style="font-size:0.844rem;font-weight:700">' + App.esc(category.name) + '</span>' +
            '<span class="num" style="font-size:0.844rem;font-weight:700;color:' + color + '">' + Math.round(status.pct_used) + "%</span></div>" +
          '<div class="tiny muted num" style="margin-top:0.125rem">' + App.esc(leftLabel) + "</div>" +
        "</div>" +
      '</div>' +
      '<div style="margin-top:0.75rem;height:0.5rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden">' +
        '<div style="height:100%;border-radius:999px;background:' + color + ";width:" + Math.min(100, status.pct_used) + '%"></div></div>' +
      '<div class="spread" style="margin-top:0.5625rem;font-size:0.72rem;font-weight:500;color:var(--neon-ink-soft)">' +
        '<span class="num"><b style="color:var(--neon-ink);font-weight:700">' + App.formatVnd(status.spent) + "</b> / " + App.formatVnd(status.amount) + "đ</span>" +
        '<span class="num" style="color:' + color + '">' + App.esc(note) + "</span>" +
      "</div>";
    } else {
      jarTop = '<div style="flex:1;min-width:0">' +
          '<div style="font-size:0.844rem;font-weight:700">' + App.esc(category.name) + "</div>" +
          '<div class="tiny muted">' + App.esc(suggestion ? App.t("plan.budget.suggested_hint", { amount: App.formatDong(suggestion) }) : App.t("plan.budget.no_suggestion")) + "</div>" +
        "</div>" +
        (suggestion
          ? '<button type="button" class="link" data-apply-suggestion="' + App.esc(category.id) + '" data-amount="' + App.esc(suggestion) + '">' + App.esc(App.t("common.use_suggestion")) + "</button>"
          : "");
    }

    return '<div class="neon-jar-card' + (status && status.over_budget ? " is-over" : (status && status.pct_used >= 85 ? " is-near" : "")) + '">' +
      '<div style="display:flex;align-items:center;gap:0.6875rem">' +
        '<span class="neon-ledger-row-icon">' + App.icon(glyph) + "</span>" +
        jarTop +
      "</div>" +
      '<label class="field" style="margin-top:0.75rem"><span class="field-label">' + App.esc(App.t("plan.budget.manual_amount_label")) + "</span>" +
      '<input type="text" inputmode="numeric" id="budget-' + App.esc(category.id) + '" data-budget-input="' + App.esc(category.id) + '"' +
      ' value="' + App.esc(value === "" ? "" : App.formatVnd(value)) + '" placeholder="' + App.esc(App.t("plan.budget.blank_placeholder")) + '"></label>' +
    "</div>";
  }).join("");

  var context = goalPerPeriod > 0
    ? '<p class="tiny muted">' + App.esc(App.t("plan.budget.goal_context", { amount: App.formatDong(goalPerPeriod) })) + "</p>"
    : "";

  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    periodNav + hero +
    '<div class="stack-tight">' + (rows || App.emptyState(App.t("plan.budget.no_categories"))) + "</div>" +
    context +
    '<div class="card tiny muted">' + App.esc(App.t("plan.budget.jars_footnote")) + "</div>" +
    '<button type="button" id="save-budgets">' + App.esc(App.t("plan.budget.save_button", { period: data.period.id })) + "</button>" +
    '<div id="budget-message"></div>' +
  "</div>";
};

// Ported from FinanceVaultsNeon.dc.html + FinanceVaultDetailNeon.dc.html.
// "Vault detail" is a genuinely new interaction this app didn't have before
// (goals only ever rendered inline in one flat list) - App.state.goalDetailId
// adds a second state to the existing "goals" plan section rather than a
// new top-level route, the same way Sổ's row-expansion adds state to one
// screen instead of a new page.
//
// Two handoff features are NOT reproduced, both fabricated without real
// backing data: the "Trích tự động" (auto-allocation) toggle - this app has
// no scheduled-transfer feature at all - and "Sửa mục tiêu" (edit target/
// deadline) - there is no update_goal action, only create + deactivate.
// The 6-bar contribution-history chart is also skipped (see the recent-list
// comment below for why); everything else here is real.
App.renderGoalsPlan = function (data) {
  if (App.state.goalDetailId) {
    var goal = data.goals.filter(function (g) { return String(g.id) === String(App.state.goalDetailId); })[0];
    if (goal) return App.renderGoalDetail(data, goal);
    App.state.goalDetailId = null; // hidden/deleted elsewhere - fall through to the list
  }

  var totalSaved = data.goals.reduce(function (sum, g) { return sum + g.current_balance; }, 0);
  var totalTarget = data.goals.reduce(function (sum, g) { return sum + g.target_amount; }, 0);
  var goalColors = ["var(--neon-green)", "var(--neon-purple)", "var(--neon-orange)", "var(--neon-red)", "var(--neon-ink-soft)"];
  var hero = data.goals.length > 0 ? '<div class="neon-vault-hero">' +
    '<div class="neon-summary-label">' + App.esc(App.t("plan.goals.total_saved")) + "</div>" +
    '<div style="margin-top:0.5rem;display:flex;align-items:flex-end;gap:0.625rem;flex-wrap:wrap">' +
      '<span class="num" style="font-size:1.875rem;font-weight:700;letter-spacing:-0.02em">' + App.formatVnd(totalSaved) + "đ</span>" +
      (totalTarget > 0 ? '<span class="num tiny muted" style="margin-bottom:0.25rem">/ ' + App.formatVnd(totalTarget) + "đ</span>" : "") +
    "</div>" +
    (totalTarget > 0
      ? '<div style="margin-top:0.875rem;height:0.625rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden;display:flex">' +
        data.goals.map(function (g, i) {
          return '<div style="height:100%;background:' + goalColors[i % goalColors.length] + ";width:" + Math.min(100, g.current_balance / totalTarget * 100) + '%"></div>';
        }).join("") + "</div>" +
        '<div class="tiny" style="margin-top:0.75rem;color:var(--neon-ink-2)">' + App.esc(App.t("plan.goals.total_saved_pct", { pct: Math.round(Math.min(100, totalSaved / totalTarget * 100)) })) + "</div>"
      : "") +
  "</div>" : "";

  var items = data.goals.map(function (g, i) {
    var color = g.is_overdue ? "var(--neon-red)" : (g.is_off_track ? "var(--neon-orange)" : "var(--neon-green)");
    var status = g.is_overdue ? App.t("plan.goals.overdue") : (g.is_off_track ? App.t("plan.goals.off_track") : App.t("plan.goals.on_track"));
    var glyph = App.categoryIconName(g.name) || "target";
    return '<div class="neon-jar-card">' +
      '<div style="display:flex;align-items:flex-start;gap:0.75rem">' +
        '<span class="neon-ledger-row-icon" style="width:2.625rem;height:2.625rem">' + App.icon(glyph === "dots" ? "target" : glyph) + "</span>" +
        '<div style="flex:1;min-width:0">' +
          '<div class="spread" style="align-items:baseline"><span style="font-size:0.875rem;font-weight:700">' + App.esc(g.name) + '</span>' +
            '<span class="num" style="font-size:0.9375rem;font-weight:700;color:' + color + '">' + Math.round(g.progress_pct) + "%</span></div>" +
          '<div class="tiny muted" style="margin-top:0.1875rem">' + App.esc(status) + " · " + App.esc(App.t("plan.goals.periods_left", { n: g.periods_remaining })) + "</div>" +
        "</div>" +
      "</div>" +
      '<div style="margin-top:0.8125rem;height:0.5rem;border-radius:999px;background:var(--neon-surface-3);overflow:hidden"><div style="height:100%;border-radius:999px;background:' + color + ";width:" + Math.min(100, g.progress_pct) + '%"></div></div>' +
      '<div class="spread num tiny" style="margin-top:0.625rem;color:var(--neon-ink-soft)">' +
        "<span><b style=\"color:var(--neon-ink);font-weight:700\">" + App.formatVnd(g.current_balance) + "</b> / " + App.formatVnd(g.target_amount) + "đ</span>" +
        '<span>' + App.esc(App.t("plan.goals.per_period_short", { amount: App.formatVnd(g.required_per_period) })) + "</span>" +
      "</div>" +
      '<div style="margin-top:0.8125rem;display:flex;gap:0.5rem">' +
        '<button type="button" class="neon-action-btn neon-action-edit" data-goal-detail="' + App.esc(g.id) + '">' + App.esc(App.t("plan.goals.topup_button")) + "</button>" +
        '<button type="button" class="neon-action-btn neon-action-dup" data-goal-detail="' + App.esc(g.id) + '">' + App.esc(App.t("plan.goals.detail_button")) + "</button>" +
      "</div>" +
    "</div>";
  }).join("");

  var aiButton = data.goals.length >= 2
    ? '<button type="button" class="secondary small" id="ai-goal-priority">' + App.esc(App.t("plan.goals.ask_ai")) + "</button>" +
      '<div class="ai-panel hidden" id="ai-goals"></div>'
    : "";

  var emergencyHint = data.money.emergency_fund_target
    ? '<p class="tiny muted">' + App.esc(App.t("plan.goals.emergency_hint", { amount: App.formatDong(data.money.emergency_fund_target) })) + "</p>"
    : "";

  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="padding:0.125rem">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("plan.goals.active_title")) + "</div>" +
      '<div class="tiny muted" style="margin-top:0.125rem">' + App.esc(App.t("plan.goals.hub_subtitle", { n: data.goals.length })) + "</div>" +
    "</div>" +
    hero +
    '<div class="stack-tight">' + (items || App.emptyState(App.t("plan.goals.none"))) + "</div>" +
    aiButton +
    '<div class="card"><h2>' + App.esc(App.t("plan.goals.add_title")) + '</h2><form id="goal-form">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.goals.name_label")) + "</span>" +
      '<input type="text" name="name" placeholder="' + App.esc(App.t("plan.goals.name_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.goals.type_label")) + '</span><select name="goal_type">' +
        Object.keys(App.LABEL_MAPS.goal_type.vi).map(function (key) {
          return '<option value="' + key + '">' + App.esc(App.label("goal_type", key)) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.goals.target_label")) + "</span>" +
      '<input type="text" inputmode="numeric" name="target_amount" placeholder="' + App.esc(App.t("plan.goals.target_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.goals.deadline_label")) + "</span>" +
      '<input type="date" name="deadline" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.goals.account_label")) + "</span>" +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, null, false) + "</select></label>" +
      emergencyHint +
      "<button type=\"submit\">" + App.esc(App.t("plan.goals.submit")) + "</button>" +
      '<div id="goal-message"></div>' +
    "</form></div>" +
  "</div>";
};

App.renderGoalDetail = function (data, goal) {
  var color = goal.is_overdue ? "var(--neon-red)" : (goal.is_off_track ? "var(--neon-orange)" : "var(--neon-green)");

  var recentContribs = (data.transactions || []).filter(function (tx) {
    return tx.is_transfer && tx.direction === "in" && String(tx.account_id) === String(goal.account_id);
  }).slice(0, 5);

  var recentHtml = recentContribs.length === 0
    ? '<p class="tiny muted">' + App.esc(App.t("plan.goals.recent_none")) + "</p>"
    : recentContribs.map(function (tx) {
        return '<div style="display:flex;align-items:center;gap:0.625rem">' +
          '<span class="neon-ledger-row-icon" style="width:1.75rem;height:1.75rem">' + App.icon("swap") + "</span>" +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:0.75rem;font-weight:600">' + App.esc(tx.description || App.t("ledger.transfer_title")) + "</div>" +
            '<div class="tiny muted num">' + App.esc(App.formatDayMonth(tx.occurred_at)) + "</div>" +
          "</div>" +
          '<span class="num" style="font-size:0.78rem;font-weight:700;color:var(--neon-green)">+' + App.formatVnd(tx.amount) + "đ</span>" +
        "</div>";
      }).join("");

  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.125rem">' +
      '<button type="button" class="icon-btn" data-goal-back aria-label="' + App.esc(App.t("common.back")) + '">' + App.icon("back") + "</button>" +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(goal.name) + "</div>" +
        '<div class="tiny muted">' + App.esc(App.label("goal_type", goal.goal_type)) + "</div>" +
      "</div>" +
    "</div>" +
    '<div class="neon-vault-hero">' +
      '<div style="display:flex;align-items:center;gap:1rem">' +
        '<div style="position:relative;flex:none;width:6rem;height:6rem">' + App.donut(goal.progress_pct, color) +
          '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
            '<span class="num" style="font-size:1.375rem;font-weight:700">' + Math.round(goal.progress_pct) + "%</span>" +
            '<span style="font-size:0.5625rem;font-weight:600;color:var(--neon-ink-soft);letter-spacing:0.05em">' + App.esc(App.t("plan.goals.donut_label")) + "</span>" +
          "</div>" +
        "</div>" +
        '<div style="flex:1;min-width:0">' +
          '<div class="num" style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">' + App.formatVnd(goal.current_balance) + "đ</div>" +
          '<div class="num tiny muted" style="margin-top:0.1875rem">/ ' + App.formatVnd(goal.target_amount) + "đ</div>" +
          (goal.remaining_amount > 0
            ? '<div class="tiny" style="margin-top:0.625rem;font-weight:600;color:' + color + '">' + App.esc(App.t("plan.goals.remaining_label", { amount: App.formatVnd(goal.remaining_amount) })) + "</div>"
            : "") +
        "</div>" +
      "</div>" +
      '<div style="margin-top:1rem;padding-top:0.875rem;border-top:1px solid var(--neon-line);display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">' +
        '<div><div class="neon-summary-label">' + App.esc(App.t("plan.goals.per_period_label")) + '</div>' +
          '<div class="num" style="margin-top:0.25rem;font-size:0.875rem;font-weight:700">' + App.formatVnd(goal.required_per_period) + "đ</div></div>" +
        '<div><div class="neon-summary-label">' + App.esc(App.t("plan.goals.eta_label")) + '</div>' +
          '<div class="num" style="margin-top:0.25rem;font-size:0.875rem;font-weight:700">' + App.esc(goal.remaining_amount <= 0 ? App.t("plan.goals.eta_done") : App.t("plan.goals.eta_periods", { n: goal.periods_remaining })) + "</div></div>" +
      "</div>" +
    "</div>" +
    '<div class="card">' +
      "<h2>" + App.esc(App.t("plan.goals.topup_title")) + "</h2>" +
      '<div class="neon-hero" style="margin-top:0.75rem;padding:1rem;--tint:rgba(63,245,165,0.14);--tint-border:rgba(63,245,165,0.35);--accent:var(--neon-green)">' +
        '<input type="text" inputmode="numeric" id="goal-topup-amount" placeholder="0đ" style="text-align:center;width:100%;border:0;background:transparent;font-family:var(--font-num);font-variant-numeric:tabular-nums;font-size:2rem;font-weight:700;color:var(--neon-green);outline:none">' +
      "</div>" +
      '<div style="margin-top:0.625rem;display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem">' +
        [["500000", "500k"], ["1000000", "1tr"], ["2500000", "2tr5"], ["rest", App.t("plan.goals.quick_rest")]].map(function (pair) {
          return '<button type="button" class="neon-chip" data-goal-quick="' + pair[0] + '">' + App.esc(pair[1]) + "</button>";
        }).join("") +
      "</div>" +
      '<div style="margin-top:0.875rem"><div class="tiny muted" style="margin-bottom:0.5rem;font-weight:600">' + App.esc(App.t("plan.goals.topup_source_label")) + "</div>" +
        '<div id="goal-topup-account-chips" style="display:flex;gap:0.5rem;flex-wrap:wrap">' +
          data.accounts.filter(function (a) { return String(a.id) !== String(goal.account_id); }).map(function (a, i) {
            return '<button type="button" class="neon-chip" data-pick-topup-account="' + App.esc(a.id) + '" aria-pressed="' + (i === 0) + '">' + App.esc(a.name) + "</button>";
          }).join("") +
        "</div>" +
        '<input type="hidden" id="goal-topup-account" value="' + App.esc((data.accounts.filter(function (a) { return String(a.id) !== String(goal.account_id); })[0] || {}).id || "") + '">' +
      "</div>" +
      '<div class="neon-ledger-detail-box" style="margin-top:0.8125rem">' +
        '<p class="tiny" style="margin:0;color:var(--neon-ink-soft)">' + App.t("plan.goals.topup_transfer_note") + "</p>" +
      "</div>" +
      '<button type="button" id="goal-topup-submit" data-goal-id="' + App.esc(goal.id) + '" style="margin-top:0.8125rem;width:100%">' + App.esc(App.t("plan.goals.topup_submit")) + "</button>" +
      '<div id="goal-topup-message"></div>' +
    "</div>" +
    '<div class="card">' +
      "<div class=\"spread\" style=\"align-items:baseline\"><h2 style=\"margin:0\">" + App.esc(App.t("plan.goals.recent_title")) + "</h2></div>" +
      '<div class="stack-tight" style="margin-top:0.625rem">' + recentHtml + "</div>" +
    "</div>" +
    '<div class="card">' +
      "<h2>" + App.esc(App.t("plan.goals.settings_title")) + "</h2>" +
      '<dl class="stack-tight" style="margin-top:0.5rem">' +
        '<div class="kv"><dt>' + App.esc(App.t("plan.goals.settings_account")) + "</dt><dd>" + App.esc(goal.account_name) + "</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.goals.target_label")) + "</dt><dd class=\"num\">" + App.formatVnd(goal.target_amount) + "đ</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.goals.deadline_label")) + "</dt><dd class=\"num\">" + App.esc(goal.deadline) + "</dd></div>" +
      "</dl>" +
      '<button type="button" class="neon-action-btn neon-action-del" style="width:100%;margin-top:0.875rem" data-hide-goal="' + App.esc(goal.id) + '">' + App.esc(App.t("common.hide")) + "</button>" +
      '<p class="tiny" style="margin-top:0.5rem;color:var(--neon-ink-dim)">' + App.esc(App.t("plan.goals.hide_note")) + "</p>" +
    "</div>" +
  "</div>";
};

App.renderRecurringPlan = function (data) {
  var rows = data.recurring.map(function (item) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">' + App.esc(item.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.label("frequency", item.frequency)) +
      " · " + App.esc(App.t("plan.recurring.next_due", { date: item.next_due })) + " · " + App.esc(item.account_name) + "</span></div>" +
      '<div class="row-end"><span class="row-amount ' + (item.direction === "in" ? "amount-in" : "amount-out") + '">' +
      (item.direction === "in" ? "+" : "−") + App.formatVnd(item.amount) + "</span>" +
      '<span class="row-actions"><button type="button" class="link link-danger" data-hide-recurring="' + App.esc(item.id) + '">' + App.esc(App.t("common.stop")) + "</button></span>" +
      "</div></div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("plan.recurring.title_card")) + "</h2></div>" +
    '<p class="tiny muted">' + App.esc(App.t("plan.recurring.hint")) + "</p>" +
    '<div class="rows">' + (rows || App.emptyState(App.t("plan.recurring.none"))) + "</div></section>" +
    '<section class="card"><h2>' + App.esc(App.t("plan.recurring.add_title")) + '</h2><form id="recurring-form">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.name_label")) + "</span>" +
      '<input type="text" name="name" placeholder="' + App.esc(App.t("plan.recurring.name_placeholder")) + '" required></label>' +
      '<div class="segmented">' +
        '<input type="radio" id="rec-out" name="direction" value="out" checked><label for="rec-out">' + App.esc(App.t("plan.recurring.direction_out")) + "</label>" +
        '<input type="radio" id="rec-in" name="direction" value="in"><label for="rec-in">' + App.esc(App.t("plan.recurring.direction_in")) + "</label>" +
      "</div>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.amount_label")) + "</span>" +
      '<input type="text" inputmode="numeric" name="amount" placeholder="' + App.esc(App.t("plan.recurring.amount_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.account_label")) + "</span>" +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, null, false) + "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.category_label")) + "</span>" +
      '<select name="category_id">' + App.categoryOptions(data.categories, "expense") + "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.frequency_label")) + '</span><select name="frequency">' +
        Object.keys(App.LABEL_MAPS.frequency.vi).map(function (key) {
          return '<option value="' + key + '"' + (key === "monthly" ? " selected" : "") + ">" + App.esc(App.label("frequency", key)) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.recurring.next_due_label")) + "</span>" +
      '<input type="date" name="next_due" required></label>' +
      "<button type=\"submit\">" + App.esc(App.t("plan.recurring.submit")) + "</button>" +
      '<div id="recurring-message"></div>' +
    "</form></section>";
};

// Ported from FinanceImportNeon.dc.html's reading/review panels. Review-
// before-save is the whole design: the model produces candidates, this
// screen is where a human confirms them, and only then does anything get
// written. Never let an image write straight into the ledger.
//
// The handoff's per-field confidence percentages and "possible duplicate of
// an existing ledger row" banner are NOT reproduced - see app.css's own note
// above the import rules for why (the backend has neither piece of data,
// and fabricating either would look precise while being invented).
App.renderImportProgress = function (current, total, foundSoFar) {
  var stageKey = current === 0 ? "import.stage_upload" : (current < total ? "import.stage_read" : "import.stage_match");
  return '<div class="neon-import-reading">' +
    '<div class="neon-import-reading-head">' +
      '<span class="neon-ai-badge">AI</span>' +
      '<span class="neon-import-reading-stage">' + App.esc(App.t(stageKey)) + "</span>" +
      '<span class="neon-import-reading-count">' + App.esc(App.t("import.progress_count", { current: current + 1, total: total })) + "</span>" +
    "</div>" +
    '<div style="display:flex;flex-direction:column;gap:0.5rem">' +
      '<span class="neon-shimmer-bar" style="width:88%"></span>' +
      '<span class="neon-shimmer-bar" style="width:64%"></span>' +
      '<span class="neon-shimmer-bar" style="width:41%"></span>' +
    "</div>" +
    (foundSoFar ? '<p class="tiny muted" style="margin:0">' + App.esc(App.t("import.found_so_far", { n: foundSoFar })) + "</p>" : "") +
  "</div>";
};

App.renderImportCandidates = function (data, candidates) {
  if (candidates.length === 0) {
    return '<p class="notice notice-info">' + App.esc(App.t("import.no_candidates")) + "</p>";
  }

  var rows = candidates.map(function (candidate, index) {
    var kind = candidate.direction === "in" ? "income" : "expense";
    var color = candidate.direction === "in" ? "var(--neon-green)" : "var(--neon-red)";
    var sign = candidate.direction === "in" ? "+" : "−";
    return '<div class="neon-import-card" data-candidate="' + index + '">' +
      '<div class="neon-import-card-head">' +
        '<label class="neon-import-use"><input type="checkbox" data-cand-use checked>' +
          '<span class="num" style="color:' + color + '">' + sign + App.formatVnd(candidate.amount) + "đ</span></label>" +
        '<span class="segmented" style="grid-auto-columns:auto;flex:none;width:auto">' +
          '<input type="radio" name="dir-' + index + '" value="out" data-cand-dir id="cd-out-' + index + '"' +
          (candidate.direction === "out" ? " checked" : "") + '><label for="cd-out-' + index + '">' + App.esc(App.t("dialog.edit_tx.direction_out")) + "</label>" +
          '<input type="radio" name="dir-' + index + '" value="in" data-cand-dir id="cd-in-' + index + '"' +
          (candidate.direction === "in" ? " checked" : "") + '><label for="cd-in-' + index + '">' + App.esc(App.t("dialog.edit_tx.direction_in")) + "</label>" +
        "</span>" +
      "</div>" +
      '<div><span class="neon-import-field-label">' + App.esc(App.t("dialog.edit_tx.amount_label")) + "</span>" +
        '<input type="text" inputmode="numeric" data-cand-amount value="' + App.esc(App.formatVnd(candidate.amount)) + '" aria-label="' + App.esc(App.t("import.amount_aria")) + '"></div>' +
      '<div><span class="neon-import-field-label">' + App.esc(App.t("ledger.detail.note")) + "</span>" +
        '<input type="text" data-cand-note value="' + App.esc(candidate.note) + '" placeholder="' + App.esc(App.t("import.note_placeholder")) + '" aria-label="' + App.esc(App.t("import.note_aria")) + '"></div>' +
      '<div style="display:flex;gap:0.625rem">' +
        '<div style="flex:1;min-width:0"><span class="neon-import-field-label">' + App.esc(App.t("dialog.edit_tx.account_label")) + "</span>" +
          '<select data-cand-account aria-label="' + App.esc(App.t("import.account_aria")) + '" style="width:100%">' + App.accountOptions(data.accounts, null, true) + "</select></div>" +
        '<div style="flex:1;min-width:0"><span class="neon-import-field-label">' + App.esc(App.t("dialog.edit_tx.category_label")) + "</span>" +
          '<select data-cand-category aria-label="' + App.esc(App.t("import.category_aria")) + '" style="width:100%">' + App.categoryOptions(data.categories, kind, candidate.category_id) + "</select></div>" +
      "</div>" +
      '<input type="hidden" data-cand-ref value="' + App.esc(candidate.external_ref) + '">' +
      "</div>";
  }).join("");

  return '<p class="small muted">' + App.t("import.summary", { n: candidates.length }) + "</p>" +
    '<div style="display:flex;flex-direction:column;gap:0.625rem">' + rows + "</div>" +
    '<button type="button" id="save-import">' + App.esc(App.t("import.save_button")) + "</button>" +
    '<div id="import-save-message"></div>';
};

// Estimated vs actual: the sources card only ever shows what was DECLARED
// (expected_amount, reliability-discounted). This answers the different
// question of whether that estimate is actually panning out - built purely
// from fields the bootstrap already sends (income_sources' own
// expected_amount, metrics.current_savings_rate's real transaction-derived
// income for the elapsed part of the period, and period.days_elapsed/total
// for the same time-vs-money pacing already used for budget jars), so it
// needed no backend change at all.
App.renderIncomeActualCard = function (data) {
  var totalExpected = data.income_sources.reduce(function (sum, s) { return sum + s.expected_amount; }, 0);
  if (totalExpected <= 0) {
    return '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("plan.income.actual_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.esc(App.t("plan.income.no_estimate_note")) + "</p>" +
    "</section>";
  }

  var actualIncome = data.metrics.current_savings_rate.income;
  var elapsedFraction = data.period.days_total > 0 ? data.period.days_elapsed / data.period.days_total : 0;
  var expectedToDate = totalExpected * elapsedFraction;
  var pct = expectedToDate > 0 ? (actualIncome / expectedToDate) * 100 : (actualIncome > 0 ? 100 : 0);

  var paceKey = pct >= 105 ? "pace_ahead" : (pct >= 90 ? "pace_on_track" : (pct >= 60 ? "pace_behind" : "pace_far_behind"));
  var paceClass = pct >= 90 ? "is-good" : (pct >= 60 ? "" : "is-warn");

  return '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("plan.income.actual_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.esc(App.t("plan.income.actual_intro")) + "</p>" +
      '<dl class="stack-tight">' +
        '<div class="kv"><dt>' + App.esc(App.t("plan.income.expected_total")) + "</dt><dd>" + App.formatDong(totalExpected) + "</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.income.expected_to_date")) + "</dt><dd>" + App.formatDong(Math.round(expectedToDate)) + "</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.income.actual_income")) + '</dt><dd class="amount-in">' + App.formatDong(actualIncome) + "</dd></div>" +
      "</dl>" +
      App.track(pct, paceClass) +
      '<p class="small ' + (paceClass || "muted") + '">' + App.esc(App.t("plan.income." + paceKey)) + "</p>" +
    "</section>";
};

App.renderIncomePlan = function (data) {
  var sustainability = data.income_sustainability;

  var rows = data.income_sources.map(function (source) {
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(source.name) + "</span>" +
      '<span class="bar-figures">' + App.formatDong(source.expected_amount) + " · " + source.reliability + "%</span></div>" +
      App.track(source.reliability, source.reliability >= 80 ? "is-good" : (source.reliability >= 50 ? "" : "is-warn")) +
      '<div class="spread tiny muted"><span>' + App.esc(App.t("plan.income.reliable_per_period_short", { amount: App.formatDong(source.reliable_amount) })) + "</span>" +
      '<button type="button" class="link link-danger" data-hide-income="' + App.esc(source.id) + '">' + App.esc(App.t("common.hide")) + "</button></div>" +
      "</div>";
  }).join("");

  var summary = "";
  if (sustainability.has_data) {
    var covered = sustainability.margin >= 0;
    summary = '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("plan.income.reliable_per_period")) + "</dt><dd>" + App.formatDong(sustainability.reliable_income) + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("plan.income.essential_per_period")) + "</dt><dd>" + App.formatDong(sustainability.essential_expense) + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("plan.income.margin")) + '</dt><dd class="' + (covered ? "amount-in" : "amount-out") + '">' +
      (covered ? "+" : "") + App.formatDong(sustainability.margin) + "</dd></div>" +
    "</dl>" +
    '<p class="small ' + (covered ? "muted" : "amount-out") + '">' +
    App.esc(covered ? App.t("plan.income.covered_note") : App.t("plan.income.not_covered_note")) +
    "</p>";
  } else {
    summary = '<p class="small muted">' + App.esc(App.t("plan.income.no_data_note")) + "</p>";
  }

  return App.renderIncomeActualCard(data) +
    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("plan.income.reliable_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.t("plan.income.reliable_intro") + "</p>" +
      summary +
    "</section>" +
    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("plan.income.sources_title")) + "</h2></div>" +
      (rows || App.emptyState(App.t("plan.income.none"))) +
    "</section>" +
    '<section class="card"><h2>' + App.esc(App.t("plan.income.add_title")) + '</h2><form id="income-form">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.income.name_label")) + "</span>" +
      '<input type="text" name="name" placeholder="' + App.esc(App.t("plan.income.name_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.income.expected_label")) + "</span>" +
      '<input type="text" inputmode="numeric" name="expected_amount" placeholder="' + App.esc(App.t("plan.income.expected_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.income.reliability_label")) + "</span>" +
      '<input type="number" name="reliability" min="0" max="100" step="5" value="100" required>' +
      '<span class="tiny faint">' + App.esc(App.t("plan.income.reliability_hint")) + "</span></label>" +
      '<button type="submit">' + App.esc(App.t("plan.income.submit")) + "</button>" +
      '<div id="income-message"></div>' +
    "</form></section>";
};

App.renderEventsPlan = function (data) {
  var upcoming = data.events.filter(function (e) { return !e.is_past; });
  var past = data.events.filter(function (e) { return e.is_past; });

  function eventCard(event) {
    var pct = event.expected_total > 0 ? (event.actual_total / event.expected_total) * 100 : 0;
    var when = event.is_past
      ? App.t("plan.events.days_ago", { n: Math.abs(event.days_until) })
      : (event.days_until === 0 ? App.t("plan.events.today") : App.t("plan.events.days_left", { n: event.days_until, period: event.period_id }));

    var items = event.items.map(function (item) {
      return '<div class="kv">' +
        "<dt>" + App.esc(item.name) + "</dt>" +
        '<dd><input type="text" inputmode="numeric" data-event-item="' + App.esc(item.id) + '"' +
        ' value="' + (item.actual_amount ? App.esc(App.formatVnd(item.actual_amount)) : "") + '"' +
        ' placeholder="' + App.esc(item.expected_amount ? App.t("plan.events.item_expected_placeholder", { amount: App.formatVnd(item.expected_amount) }) : App.t("plan.events.item_no_estimate_placeholder")) + '"' +
        ' style="width:8rem;min-height:2.2rem;padding:0.3rem 0.5rem;font-size:0.875rem"></dd>' +
        "</div>";
    }).join("");

    var goalPrompt = event.should_suggest_goal
      ? '<div class="notice notice-info">' +
        "<p>" + App.esc(App.t("plan.events.goal_prompt", { amount: App.formatDong(event.remaining_total), periods: event.periods_until })) + "</p>" +
        '<button type="button" class="link" data-event-to-goal="' + App.esc(event.id) + '">' + App.esc(App.t("plan.events.goal_prompt_cta")) + "</button>" +
        "</div>"
      : "";

    return '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(event.name) + "</h2>" +
      '<button type="button" class="link link-danger" data-delete-event="' + App.esc(event.id) + '">' + App.esc(App.t("common.delete")) + "</button></div>" +
      '<p class="tiny muted">' + App.esc(event.event_date) + " · " + App.esc(when) +
      (event.linked_goal_id ? " " + App.esc(App.t("plan.events.linked_goal_tag")) : "") + "</p>" +
      '<dl class="stack-tight">' +
        '<div class="kv"><dt>' + App.esc(App.t("plan.events.expected")) + "</dt><dd>" + App.formatDong(event.expected_total) + "</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.events.actual")) + "</dt><dd>" + App.formatDong(event.actual_total) + "</dd></div>" +
        '<div class="kv"><dt>' + App.esc(App.t("plan.events.remaining")) + '</dt><dd class="' + (event.remaining_total > 0 ? "amount-out" : "amount-in") + '">' +
        App.formatDong(event.remaining_total) + "</dd></div>" +
      "</dl>" +
      App.track(pct, pct > 100 ? "is-over" : "is-good") +
      goalPrompt +
      '<p class="eyebrow" style="margin-top:0.5rem">' + App.esc(App.t("plan.events.actual_per_item_title")) + "</p>" +
      '<dl class="stack-tight">' + items + "</dl>" +
      '<p class="tiny faint">' + App.esc(App.t("plan.events.item_footnote")) + "</p>" +
      "</section>";
  }

  var templateOptions = data.event_templates.map(function (template, index) {
    return '<option value="' + index + '">' + App.esc(template.name) + "</option>";
  }).join("");

  return (upcoming.length ? upcoming.map(eventCard).join("") : '<section class="card">' +
      "<h2>" + App.esc(App.t("plan.events.upcoming_title")) + "</h2>" + App.emptyState(App.t("plan.events.none")) +
      '<p class="tiny muted">' + App.esc(App.t("plan.events.none_hint")) + "</p></section>") +
    '<section class="card"><h2>' + App.esc(App.t("plan.events.plan_title")) + '</h2><form id="event-form">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.events.name_label")) + "</span>" +
      '<input type="text" name="name" placeholder="' + App.esc(App.t("plan.events.name_placeholder")) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.events.date_label")) + "</span>" +
      '<input type="date" name="event_date" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.events.template_label")) + "</span>" +
      '<select id="event-template"><option value="">' + App.esc(App.t("common.custom_from_scratch")) + "</option>" + templateOptions + "</select>" +
      '<span class="tiny faint">' + App.esc(App.t("plan.events.template_hint")) + "</span></label>" +
      '<p class="eyebrow" style="margin-top:0.5rem">' + App.esc(App.t("plan.events.items_title")) + "</p>" +
      '<div id="event-items"></div>' +
      '<button type="button" class="secondary small" id="add-event-item">' + App.esc(App.t("plan.events.add_item")) + "</button>" +
      '<button type="submit">' + App.esc(App.t("plan.events.save")) + "</button>" +
      '<div id="event-message"></div>' +
    "</form></section>" +
    (past.length
      ? '<section class="card"><h2>' + App.esc(App.t("plan.events.past_title")) + "</h2>" + past.map(function (event) {
          return '<div class="row"><div class="row-main"><span class="row-title">' + App.esc(event.name) + "</span>" +
            '<span class="row-meta">' + App.esc(event.event_date) + "</span></div>" +
            '<div class="row-end"><span class="row-amount">' + App.formatVnd(event.actual_total) + " đ</span>" +
            '<span class="row-actions"><button type="button" class="link link-danger" data-delete-event="' +
            App.esc(event.id) + '">' + App.esc(App.t("common.delete")) + "</button></span></div></div>";
        }).join("") + "</section>"
      : "");
};

App.eventItemRow = function (name, readonly) {
  return '<div class="inline" style="gap:0.5rem;margin-bottom:0.5rem">' +
    '<input type="text" class="grow" data-item-name value="' + App.esc(name || "") + '"' +
    (readonly ? " readonly" : "") + ' placeholder="' + App.esc(App.t("plan.events.item_name_placeholder")) + '">' +
    '<input type="text" inputmode="numeric" data-item-amount placeholder="' + App.esc(App.t("plan.events.item_amount_placeholder")) + '" style="width:8rem">' +
    "</div>";
};

// Ported from FinanceForecastNeon.dc.html's chart + verdict, minus the
// health-score ring (already Home's own headline metric, not duplicated
// here) and the income-sources/upcoming-events cards (those stay their own
// separate Kế hoạch sections - Nguồn thu/Sự kiện - rather than folding into
// Dự báo, since this app's IA never merged them and the handoff's own
// "one screen" grouping doesn't map onto that without real duplication).
App.renderForecastPlan = function () {
  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="padding:0.125rem">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("plan.forecast.title")) + "</div>" +
      '<p class="tiny muted" style="margin-top:0.25rem">' + App.esc(App.t("plan.forecast.intro")) + "</p>" +
    "</div>" +
    '<div class="card">' +
      '<label class="inline small"><input type="checkbox" id="forecast-goals" style="width:auto;min-height:0"> ' + App.esc(App.t("plan.forecast.include_goals")) + "</label>" +
      '<label class="inline small"><input type="checkbox" id="forecast-reliable" style="width:auto;min-height:0"> ' + App.esc(App.t("plan.forecast.reliable_income_only")) + "</label>" +
      '<p class="tiny faint">' + App.esc(App.t("plan.forecast.events_note")) + "</p>" +
      '<button type="button" id="run-forecast">' + App.esc(App.t("plan.forecast.run")) + "</button>" +
    "</div>" +
    '<div id="forecast-result"></div>' +
  "</div>";
};

App.renderForecastResult = function (result) {
  if (result.periods_of_history === 0) {
    return '<p class="notice notice-info">' + App.esc(App.t("plan.forecast.no_history")) + "</p>";
  }
  var balances = result.periods.map(function (p) { return p.projected_balance; });
  var labels = result.periods.map(function (p) { return p.period_id.slice(5) + "/" + p.period_id.slice(2, 4); });
  var worst = Math.min.apply(null, balances);
  var verdictColor = worst < 0 ? "var(--neon-red)" : worst < result.avg_expense ? "var(--neon-orange)" : "var(--neon-green)";

  var rows = result.periods.map(function (p) {
    return '<div class="kv"><dt>' + App.esc(App.t("plan.forecast.period_row_label", { period: p.period_id })) +
      (p.event_cost > 0 ? ' <span class="tiny" style="color:var(--neon-red)">' + App.esc(App.t("plan.forecast.event_cost_tag", { amount: App.formatVnd(p.event_cost) })) + "</span>" : "") +
      "</dt><dd class=\"num\" style=\"color:" + (p.projected_balance < 0 ? "var(--neon-red)" : "var(--neon-ink)") + '">' +
      App.formatDong(p.projected_balance) + "</dd></div>";
  }).join("");

  return '<div class="card">' +
    '<div style="display:flex;align-items:baseline;gap:0.5rem"><span style="width:0.5rem;height:0.5rem;border-radius:2px;transform:rotate(45deg);background:' + verdictColor + '"></span>' +
      '<span style="font-size:0.8125rem;font-weight:700;color:' + verdictColor + '">' + App.formatVnd(worst) + "đ</span>" +
      '<span class="tiny muted">' + App.esc(App.t("plan.forecast.lowest_point")) + "</span></div>" +
    App.lineChart(labels, balances) +
    '<dl class="stack-tight">' + rows + "</dl>" +
    '<p class="tiny faint">' + App.esc(App.t("plan.forecast.footnote", {
      income: App.formatVnd(result.income_per_period),
      income_basis: result.income_basis === "reliable"
        ? App.t("plan.forecast.basis_reliable")
        : App.t("plan.forecast.basis_average", { n: result.periods_of_history }),
      expense: App.formatVnd(result.avg_expense),
      goal: result.goal_contribution > 0 ? App.t("plan.forecast.goal_note", { amount: App.formatVnd(result.goal_contribution) }) : "",
      event: result.event_total > 0 ? App.t("plan.forecast.event_note", { amount: App.formatVnd(result.event_total) }) : "",
    })) + "</p>" +
  "</div>";
};

// Ported from FinanceSimulateNeon.dc.html. All 6 real scenarios (pay now,
// 3/6/12-installment, delay 3/6, no-purchase baseline) are kept - the
// handoff's own mock only shows 3, but this app's richer comparison already
// existed and works, so nothing was cut to match a smaller mock.
// Tapping a scenario card recolors the chart to THAT scenario's own
// trajectory against the no-purchase baseline (App.state.simSelectedScenario,
// default "now" - "should I buy this today" is the question this form is
// almost always answering). App.lineChart's new altSeries/color options
// exist specifically for this - see its own comment.
App.renderSimulationPlan = function () {
  return '<div style="display:flex;flex-direction:column;gap:0.875rem">' +
    '<div style="padding:0.125rem">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("plan.simulate.title")) + "</div>" +
      '<p class="tiny muted" style="margin-top:0.25rem">' + App.esc(App.t("plan.simulate.intro")) + "</p>" +
    "</div>" +
    '<div class="card">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.item_label")) + "</span>" +
      '<input type="text" id="sim-name" placeholder="' + App.esc(App.t("plan.simulate.item_placeholder")) + '"></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.price_label")) + "</span>" +
      '<input type="text" inputmode="numeric" id="sim-amount" class="amount-input" placeholder="' + App.esc(App.t("plan.simulate.price_placeholder")) + '"></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.maintenance_label")) + "</span>" +
      '<input type="text" inputmode="numeric" id="sim-maintenance" placeholder="' + App.esc(App.t("plan.simulate.maintenance_placeholder")) + '"></label>' +
      '<button type="button" id="run-simulation">' + App.esc(App.t("plan.simulate.run")) + "</button>" +
    "</div>" +
    '<div id="simulation-result"></div>' +
  "</div>";
};

App.SIM_TRAFFIC_COLOR = { green: "var(--neon-green)", yellow: "var(--neon-orange)", red: "var(--neon-red)" };

App.renderScenarios = function (result) {
  var selectedKey = App.state.simSelectedScenario || "now";
  var selected = result.scenarios.filter(function (s) { return s.key === selectedKey; })[0] || result.scenarios[1];
  var color = App.SIM_TRAFFIC_COLOR[selected.traffic_light];

  var itemCard = result.item_name ? '<div class="card" style="border-color:rgba(255,107,122,0.28);flex-direction:row;align-items:center;gap:0.75rem">' +
      '<span class="neon-ledger-row-icon" style="background:rgba(255,107,122,0.13);color:var(--neon-red)">' + App.icon("cash") + "</span>" +
      '<div style="flex:1;min-width:0"><div class="tiny muted">' + App.esc(App.t("plan.simulate.item_under_review")) + "</div>" +
        '<div style="font-size:0.8125rem;font-weight:600;margin-top:0.125rem">' + App.esc(result.item_name) + "</div></div>" +
      '<span class="num" style="font-size:1rem;font-weight:700;color:var(--neon-red)">−' + App.formatVnd(result.total_cost) + "đ</span>" +
    "</div>" : "";

  var cards = result.scenarios.map(function (scenario) {
    var when;
    if (scenario.first_negative) {
      when = App.t("plan.simulate.negative_from", { period: scenario.period_labels[scenario.first_negative - 1], n: scenario.first_negative });
    } else if (scenario.first_below_threshold) {
      when = App.t("plan.simulate.below_threshold_from", { period: scenario.period_labels[scenario.first_below_threshold - 1] });
    } else {
      when = App.t("plan.simulate.never_breaks");
    }
    var isOn = scenario.key === selectedKey;
    var scColor = App.SIM_TRAFFIC_COLOR[scenario.traffic_light];
    return '<button type="button" class="neon-jar-card" style="text-align:left;cursor:pointer' + (isOn ? ";border-color:" + scColor : "") + '" data-sim-scenario="' + App.esc(scenario.key) + '">' +
      '<div style="display:flex;align-items:center;gap:0.6875rem">' +
        '<span style="flex:none;width:0.625rem;height:0.625rem;border-radius:999px;background:' + scColor + ";box-shadow:0 0 8px " + scColor + '"></span>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:0.844rem;font-weight:700">' + App.esc(scenario.label) + (scenario.key === "none" ? App.esc(App.t("plan.simulate.compare_tag")) : "") + "</div>" +
          '<div class="tiny muted" style="margin-top:0.125rem">' + App.esc(when) + "</div>" +
        "</div>" +
        '<div style="text-align:right;flex:none">' +
          '<div class="num" style="font-size:0.844rem;font-weight:700;color:' + scColor + '">' + App.formatVnd(scenario.lowest_balance) + "đ</div>" +
          '<div style="font-size:0.625rem;font-weight:600;color:var(--neon-ink-dim);letter-spacing:0.04em">' + App.esc(App.t("plan.simulate.floor_tag")) + "</div>" +
        "</div>" +
      "</div>" +
    "</button>";
  }).join("");

  return '<div style="display:flex;flex-direction:column;gap:0.75rem">' +
    itemCard +
    '<div class="stack-tight">' + cards + "</div>" +
    '<div class="card">' +
      '<div class="spread" style="align-items:center">' +
        '<h2 style="margin:0">' + App.esc(App.t("plan.simulate.chart_title")) + "</h2>" +
        '<div style="display:flex;gap:0.625rem;font-size:0.625rem;font-weight:600;color:var(--neon-ink-soft)">' +
          '<span style="display:flex;align-items:center;gap:0.3rem"><span style="width:0.75rem;height:0.125rem;background:' + color + '"></span>' + App.esc(App.t("plan.simulate.legend_with")) + "</span>" +
          '<span style="display:flex;align-items:center;gap:0.3rem"><span style="width:0.75rem;height:0.125rem;background:var(--neon-ink-faint)"></span>' + App.esc(App.t("plan.simulate.legend_without")) + "</span>" +
        "</div>" +
      "</div>" +
      App.lineChart(result.labels, selected.series, { altSeries: result.baseline_series, color: color }) +
    "</div>" +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("plan.simulate.total_cost")) + "</dt><dd>" + App.formatDong(result.total_cost) + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("plan.simulate.current_balance")) + "</dt><dd>" + App.formatDong(result.starting_balance) + "</dd></div>" +
    "</dl>" +
    '<button type="button" class="secondary" id="ai-simulation">' + App.esc(App.t("plan.simulate.ask_ai")) + "</button>" +
    '<div class="ai-panel hidden" id="ai-sim-panel"></div>' +
  "</div>";
};

// =============================================================== cài đặt

// Ported from FinanceProfileNeon.dc.html's header only - its user identity
// (name/email/avatar), "PRO" badge, and months-used/streak/bank-sync-status
// stat cards are all fabricated data this app has no source for (no login,
// no per-account sync, no subscription). Kept: a real 3-stat row (accounts/
// transactions/rules, all already-known counts) and the divider-row visual
// language for the accounts list, wrapping the REST of Settings (appearance,
// language, connection, categories, rules, data export - none of which the
// handoff's own Profile screen covers) unchanged in structure, just re-skinned
// via .neon-plan-section the same way Ngân sách/Dự báo/Phân tích are.
App.renderSettings = function (data) {
  var header = '<div style="padding:0.125rem">' +
      '<div style="font-size:1.0625rem;font-weight:700;letter-spacing:-0.01em">' + App.esc(App.t("settings.page_title")) + "</div>" +
      '<div class="tiny muted" style="margin-top:0.125rem">' + App.esc(App.t("settings.page_subtitle")) + "</div>" +
    "</div>" +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.625rem">' +
      [
        [data ? data.accounts.length : 0, App.t("settings.stat_accounts")],
        [data ? data.transaction_count : 0, App.t("settings.stat_transactions")],
        [data ? data.rules.length : 0, App.t("settings.stat_rules")],
      ].map(function (pair) {
        return '<div class="card" style="padding:0.8125rem 0.75rem">' +
          '<div class="num" style="font-size:1.1875rem;font-weight:700">' + pair[0] + "</div>" +
          '<div class="tiny muted" style="margin-top:0.1875rem;line-height:1.25">' + App.esc(pair[1]) + "</div>" +
        "</div>";
      }).join("") +
    "</div>";

  var accountRows = (data ? data.accounts : []).map(function (account) {
    return '<div class="row">' +
      '<span class="row-icon">' + App.icon(App.ACCOUNT_ICONS[account.type] || "wallet") + "</span>" +
      '<div class="row-main"><span class="row-title">' + App.esc(account.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.label("account_type", account.type)) + "</span></div>" +
      '<div class="row-end"><span class="row-amount">' + App.formatDong(account.balance) + "</span>" +
      '<span class="row-actions"><button type="button" class="link" data-edit-account="' + App.esc(account.id) + '">' + App.esc(App.t("common.edit")) + "</button></span>" +
      "</div></div>";
  }).join("");

  var ruleRows = (data ? data.rules : []).map(function (rule) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">“' + App.esc(rule.pattern) + "”</span>" +
      '<span class="row-meta">' + App.esc(App.t("settings.rule_matched", { category: rule.category_name, n: rule.hit_count })) + "</span></div>" +
      '<div class="row-end"><span class="row-actions">' +
      '<button type="button" class="link link-danger" data-delete-rule="' + App.esc(rule.id) + '">' + App.esc(App.t("common.delete")) + "</button>" +
      "</span></div></div>";
  }).join("");

  var categoryCount = data ? data.categories.length : 0;

  var themeButtons = ["auto", "light", "dark"].map(function (key) {
    return '<button type="button" class="swatch" data-set-theme="' + key + '" aria-pressed="' +
      (App.currentTheme() === key) + '"><span>' + App.esc(App.label("theme", key)) + "</span></button>";
  }).join("");

  var paletteButtons = App.PALETTES.map(function (palette) {
    return '<button type="button" class="swatch" data-set-palette="' + palette.key + '" aria-pressed="' +
      (App.currentPalette() === palette.key) + '">' +
      '<span class="dot" style="background:' + palette.dot + '"></span>' +
      "<span>" + App.esc(App.label("palette", palette.key)) + "</span></button>";
  }).join("");

  var appearanceCard = '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.appearance_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.esc(App.t("settings.appearance_hint")) + "</p>" +
      '<div class="swatch-row">' + themeButtons + "</div>" +
      '<div class="swatch-row">' + paletteButtons + "</div>" +
    "</section>";

  var langButtons = App.LANGS.map(function (lang) {
    return '<button type="button" class="swatch" data-set-lang="' + lang.key + '" aria-pressed="' +
      (App.currentLang() === lang.key) + '"><span>' + App.esc(lang.label) + "</span></button>";
  }).join("");

  // Language names are shown in their own language ("Tiếng Việt" / "English")
  // rather than translated - the same convention every bilingual app uses,
  // since translating a language's own name into itself is meaningless and
  // translating it into the OTHER language just makes the picker harder to
  // scan for someone who can't yet read the current one.
  var languageCard = '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.language_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.esc(App.t("settings.language_hint")) + "</p>" +
      '<div class="swatch-row">' + langButtons + "</div>" +
    "</section>";

  return header + appearanceCard + languageCard +
    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.connection_title")) + "</h2>" +
      '<button type="button" class="link" id="show-connection">' + App.esc(App.t("common.change")) + "</button></div>" +
      '<p class="small muted">' + App.esc(App.t("settings.connection_hint")) + "</p>" +
      '<p class="tiny faint" id="connection-url"></p>' +
      '<button type="button" class="secondary small" id="device-link-btn">' + App.esc(App.t("settings.device_link_btn")) + "</button>" +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.status_title")) + '</h2>' +
      '<span class="tiny faint num" id="code-version"></span></div>' +
      '<div id="version-notice"></div>' +
      '<p class="small muted">' + App.esc(App.t("settings.status_hint")) + "</p>" +
      '<div class="button-row">' +
        '<button type="button" class="secondary" id="run-health-check">' + App.esc(App.t("settings.run_health_check")) + "</button>" +
        '<button type="button" class="secondary" id="run-setup-seed">' + App.esc(App.t("settings.run_setup_seed")) + "</button>" +
      "</div>" +
      '<div id="setup-message"></div>' +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.accounts_title")) + '</h2><span class="small muted">' + (data ? data.accounts.length : 0) + "</span></div>" +
      '<div class="rows">' + (accountRows || App.emptyState(App.t("settings.accounts_empty"))) + "</div>" +
      '<form id="account-form">' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.account_new_name_label")) + "</span>" +
        '<input type="text" name="name" placeholder="' + App.esc(App.t("settings.account_new_name_placeholder")) + '" required></label>' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.account_type_label")) + '</span><select name="type">' +
          Object.keys(App.LABEL_MAPS.account_type.vi).map(function (key) {
            return '<option value="' + key + '">' + App.esc(App.label("account_type", key)) + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.account_balance_label")) + "</span>" +
        '<input type="text" inputmode="numeric" name="balance" placeholder="0"></label>' +
        '<button type="submit" class="secondary">' + App.esc(App.t("settings.account_add")) + "</button>" +
        '<div id="account-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.categories_title")) + '</h2><span class="small muted">' + categoryCount + "</span></div>" +
      '<form id="category-form">' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.category_new_name_label")) + "</span>" +
        '<input type="text" name="name" placeholder="' + App.esc(App.t("settings.category_new_name_placeholder")) + '" required></label>' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.category_kind_label")) + '</span><select name="kind">' +
          Object.keys(App.LABEL_MAPS.category_kind.vi).map(function (key) {
            return '<option value="' + key + '">' + App.esc(App.label("category_kind", key)) + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.category_necessity_label")) + '</span><select name="necessity">' +
          ["", "essential", "optional"].map(function (key) {
            return '<option value="' + key + '">' + App.esc(App.label("necessity", key)) + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.category_stability_label")) + '</span><select name="stability">' +
          ["", "fixed", "variable"].map(function (key) {
            return '<option value="' + key + '">' + App.esc(App.label("stability", key)) + "</option>";
          }).join("") +
        "</select></label>" +
        '<p class="tiny muted">' + App.esc(App.t("settings.category_hint")) + "</p>" +
        '<button type="submit" class="secondary">' + App.esc(App.t("settings.category_add")) + "</button>" +
        '<div id="category-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("settings.rules_title")) + "</h2></div>" +
      '<p class="small muted">' + App.esc(App.t("settings.rules_hint")) + "</p>" +
      '<div class="rows">' + (ruleRows || App.emptyState(App.t("settings.rules_empty"))) + "</div>" +
      '<form id="rule-form">' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.rule_pattern_label")) + "</span>" +
        '<input type="text" name="pattern" placeholder="' + App.esc(App.t("settings.rule_pattern_placeholder")) + '" required></label>' +
        '<label class="field"><span class="field-label">' + App.esc(App.t("settings.rule_category_label")) + '</span><select name="category_id">' +
          (data ? App.categoryOptions(data.categories, "expense", null, false) : "") + "</select></label>" +
        '<button type="submit" class="secondary">' + App.esc(App.t("settings.rule_add")) + "</button>" +
        '<div id="rule-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card"><h2>' + App.esc(App.t("settings.data_title")) + "</h2>" +
      '<p class="small muted">' + App.esc(App.t("settings.data_hint")) + "</p>" +
      '<button type="button" class="secondary" id="export-csv">' + App.esc(App.t("settings.export_csv")) + "</button>" +
      '<button type="button" class="secondary" id="reset-connection">' + App.esc(App.t("settings.reset_connection")) + "</button>" +
    "</section>";
};
