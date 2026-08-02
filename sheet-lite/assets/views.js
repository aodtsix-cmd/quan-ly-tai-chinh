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

App.healthChip = function (level) {
  if (!level) return '<span class="chip chip-neutral"><span class="chip-dot"></span>' + App.esc(App.t("health.chip.no_data")) + "</span>";
  return '<span class="chip chip-' + level + '"><span class="chip-dot"></span>' + App.esc(App.label("health", level)) + "</span>";
};

App.track = function (pct, modifier) {
  var width = Math.max(0, Math.min(Number(pct) || 0, 100));
  return '<div class="track"><div class="track-fill ' + (modifier || "") + '" style="width:' + width + '%"></div></div>';
};

App.metricTile = function (label, value, note, iconName) {
  return '<div class="metric">' +
    (iconName ? '<span class="metric-icon">' + App.icon(iconName) + "</span>" : "") +
    '<span class="metric-label">' + App.esc(label) + "</span>" +
    '<span class="metric-value">' + value + "</span>" +
    (note ? '<span class="metric-note">' + App.esc(note) + "</span>" : "") +
    "</div>";
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
App.lineChart = function (labels, series) {
  if (!series || series.length < 2) return "";
  var width = 320, height = 130, padL = 4, padR = 4, padT = 10, padB = 18;
  var values = series.slice();
  var min = Math.min.apply(null, values.concat([0]));
  var max = Math.max.apply(null, values.concat([0]));
  var span = (max - min) || 1;
  var stepX = (width - padL - padR) / (values.length - 1);

  function yFor(value) { return padT + (1 - (value - min) / span) * (height - padT - padB); }

  var points = values.map(function (value, index) { return [padL + index * stepX, yFor(value)]; });
  var line = points.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
  var baseY = yFor(Math.max(min, 0));
  var area = line + " L" + points[points.length - 1][0].toFixed(1) + " " + baseY.toFixed(1) +
    " L" + points[0][0].toFixed(1) + " " + baseY.toFixed(1) + " Z";

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
    '<path class="area" d="' + area + '"/>' + zero +
    '<path class="series" d="' + line + '"/>' +
    '<circle class="endpoint" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3"/>' +
    ticks + "</svg>";
};

// ================================================================ dashboard

App.renderAlerts = function (alerts) {
  if (!alerts || alerts.length === 0) return "";
  return alerts.map(function (alert) {
    return '<div class="alert alert-' + App.esc(alert.level) + '" data-alert="' + App.esc(alert.code) + '">' +
      "<p>" + App.esc(alert.message) + "</p>" +
      '<button type="button" class="link" data-dismiss-alert="' + App.esc(alert.code) + '">' + App.esc(App.t("common.close")) + "</button>" +
      "</div>";
  }).join("");
};

// The signature element. Two tracks on one scale: how much of the period has
// gone, and how much of the money has gone. The gap between them is the
// reading - you don't have to compare two numbers in your head.
App.renderRibbon = function (data) {
  var period = data.period;
  var timePct = period.days_total > 0 ? (period.days_elapsed / period.days_total) * 100 : 0;

  var moneyPct = null;
  var moneyLabel = "";
  if (data.metrics.burn_rate.has_data) {
    moneyPct = data.metrics.burn_rate.pct_spent;
    moneyLabel = App.t("home.ribbon.budget_word");
  } else {
    // No budget set yet: fall back to this period's spend against the recent
    // average period spend, so the ribbon still says something true.
    var periods = data.metrics.savings_trend.periods || [];
    if (periods.length > 0) {
      var avg = periods.reduce(function (sum, p) { return sum + p.expense; }, 0) / periods.length;
      if (avg > 0) {
        moneyPct = (data.metrics.current_savings_rate.expense / avg) * 100;
        moneyLabel = App.t("home.ribbon.avg_period_word");
      }
    }
  }

  var rows =
    '<div class="ribbon-row">' +
      '<span class="ribbon-label">' + App.esc(App.t("home.ribbon.time_label")) + "</span>" +
      App.track(timePct, "is-time") +
      '<span class="ribbon-value">' + Math.round(timePct) + "%</span>" +
    "</div>";

  var note;
  if (moneyPct === null) {
    note = App.t("home.ribbon.no_budget_note");
  } else {
    var modifier = moneyPct > 100 ? "is-over" : (moneyPct > timePct + 10 ? "is-warn" : (moneyPct < timePct - 10 ? "is-good" : ""));
    rows +=
      '<div class="ribbon-row">' +
        '<span class="ribbon-label">' + App.esc(App.t("home.ribbon.money_label")) + "</span>" +
        App.track(moneyPct, modifier) +
        '<span class="ribbon-value">' + Math.round(moneyPct) + "%</span>" +
      "</div>";
    // Kept strictly factual. The judgement ("đang tiêu nhanh hơn nhịp") is
    // the health score's job, right above - saying it in both places reads
    // as the app repeating itself.
    note = App.t("home.ribbon.note", {
      timePct: Math.round(timePct),
      moneyPct: Math.round(moneyPct),
      label: moneyLabel,
    });
  }

  return '<div class="ribbon">' + rows + '<p class="ribbon-note">' + App.esc(note) + "</p></div>";
};

App.renderHero = function (data) {
  var health = data.health;
  var blurb = health.has_data
    ? App.label("health_blurb", health.level)
    : App.t("home.hero.blurb_no_data");

  var reasons = (health.downgraded_reasons || []).length
    ? '<p class="small"><b>' + App.esc(App.t("home.hero.downgraded_label")) + '</b> <span class="muted">' +
      App.esc(health.downgraded_reasons.join(" ")) + "</span></p>"
    : "";

  return '<section class="card hero">' +
    '<div class="hero-top">' +
      "<div>" +
        '<span class="eyebrow">' + App.esc(App.t("home.hero.eyebrow")) + "</span>" +
        '<p class="hero-balance">' + App.formatVnd(data.money.liquid_balance) + '<span class="unit">đ</span></p>' +
      "</div>" +
      App.healthChip(health.has_data ? health.level : null) +
    "</div>" +
    '<div class="hero-sub small muted">' +
      "<span>" + App.t("home.hero.net_worth", { amount: "<b class=\"num\">" + App.formatVnd(data.money.net_worth) + " đ</b>" }) + "</span>" +
      (health.runway_months !== null
        ? "<span>" + App.t("home.hero.runway", { months: "<b class=\"num\">" + App.formatNumber(health.runway_months) + "</b>" }) + "</span>"
        : "") +
    "</div>" +
    '<p class="small muted">' + App.esc(blurb) + "</p>" + reasons +
    App.renderRibbon(data) +
    "</section>";
};

App.renderMetrics = function (data) {
  var money = data.money;
  var metrics = data.metrics;

  var tiles = [
    App.metricTile(App.t("metric.survival.label"),
      money.survival_days !== null ? App.formatNumber(money.survival_days, 0) + '<span class="u">' + App.esc(App.t("metric.survival.unit_days")) + "</span>" : "—",
      money.survival_days !== null ? App.t("metric.survival.note_has_data") : App.t("metric.survival.note_no_data"), "clock"),

    App.metricTile(App.t("metric.forecast.label"),
      '<span class="' + (money.at_risk ? "amount-out" : "") + '">' + App.formatVnd(money.forecast_balance) + " đ</span>",
      App.t("metric.forecast.note", { days: data.period.days_remaining }), "chart"),

    App.metricTile(App.t("metric.savings.label"),
      metrics.current_savings_rate.has_data ? App.formatPct(metrics.current_savings_rate.rate) : "—",
      metrics.current_savings_rate.has_data ? App.t("metric.savings.note_has_data") : App.t("metric.savings.note_no_data"), "bank"),

    App.metricTile(App.t("metric.concentration.label"),
      metrics.concentration.has_data
        ? '<span class="as-text">' + App.esc(metrics.concentration.category_name) + "</span>"
        : "—",
      metrics.concentration.has_data ? App.t("metric.concentration.note_has_data", { pct: App.formatPct(metrics.concentration.pct) }) : App.t("metric.concentration.note_no_data"),
      metrics.concentration.has_data ? App.categoryIconName(metrics.concentration.category_name) : "pie"),

    App.metricTile(App.t("metric.rigidity.label"),
      metrics.rigidity.has_data ? App.formatPct(metrics.rigidity.pct) : "—",
      metrics.rigidity.has_data ? App.t("metric.rigidity.note_has_data") : App.t("metric.rigidity.note_no_data"), "shield"),

    App.metricTile(App.t("metric.income_stability.label"),
      metrics.income_stability.has_data ? App.formatPct(metrics.income_stability.cv_pct) : "—",
      metrics.income_stability.has_data ? App.t("metric.income_stability.note_has_data") : App.t("metric.income_stability.note_no_data"), "scale"),
  ];

  if (data.income_sustainability.has_data) {
    var margin = data.income_sustainability.margin;
    tiles.push(App.metricTile(App.t("metric.reliable_income.label"),
      '<span class="' + (margin >= 0 ? "amount-in" : "amount-out") + '">' +
      App.formatPct(data.income_sustainability.covered_pct) + "</span>",
      margin >= 0 ? App.t("metric.reliable_income.note_covered") : App.t("metric.reliable_income.note_not_covered"), "salary"));
  }

  return '<div class="metric-grid">' + tiles.join("") + "</div>";
};

App.renderBudgetReminders = function (data) {
  var statuses = data.budget_statuses.slice(0, 3);
  if (statuses.length === 0) return "";

  var items = statuses.map(function (status) {
    var text = status.over_budget
      ? App.t("home.budget_reminders.over", { amount: App.formatDong(-status.remaining) })
      : App.t("home.budget_reminders.remaining", { amount: App.formatDong(status.remaining), days: data.period.days_remaining });
    var modifier = status.over_budget ? "is-over" : (status.pct_used > 85 ? "is-warn" : "");
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(status.category_name) + "</span>" +
      '<span class="bar-figures">' + App.formatVnd(status.spent) + " / " + App.formatVnd(status.amount) + "</span></div>" +
      App.track(status.pct_used, modifier) +
      '<p class="tiny ' + (status.over_budget ? "amount-out" : "muted") + '">' + App.esc(text) + "</p>" +
      "</div>";
  }).join("");

  var streak = data.metrics.budget_streak > 0
    ? '<p class="tiny muted">' + App.esc(App.t("home.budget_reminders.streak", { n: data.metrics.budget_streak })) + "</p>"
    : "";

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.budget_reminders.title")) + "</h2>" +
    '<button type="button" class="link" data-goto="plan:budget">' + App.esc(App.t("common.edit")) + "</button></div>" +
    items + streak + "</section>";
};

App.renderGoalsSummary = function (data) {
  if (data.goals.length === 0) return "";
  var behind = data.goals.filter(function (g) { return g.is_off_track || g.is_overdue; });
  var perPeriod = data.goals.reduce(function (sum, g) { return g.is_overdue ? sum : sum + g.required_per_period; }, 0);

  var note = behind.length === 0
    ? App.t("home.goals_summary.all_on_track")
    : App.t("home.goals_summary.behind", { count: behind.length, names: behind.map(function (g) { return g.name; }).join(", ") });

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.goals_summary.title")) + "</h2>" +
    '<button type="button" class="link" data-goto="plan:goals">' + App.esc(App.t("common.view_all")) + "</button></div>" +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("home.goals_summary.pursuing")) + "</dt><dd>" + data.goals.length + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("home.goals_summary.need_per_period")) + "</dt><dd>" + App.formatDong(perPeriod) + "</dd></div>" +
    "</dl>" +
    '<p class="small ' + (behind.length ? "amount-out" : "muted") + '">' + App.esc(note) + "</p>" +
    "</section>";
};

App.renderEventCard = function (data) {
  var upcoming = data.events.filter(function (event) {
    return !event.is_past && event.remaining_total > 0;
  })[0];
  if (!upcoming) return "";

  // Cross-referencing the forecast: can today's liquid balance absorb it?
  var affordable = data.money.liquid_balance >= upcoming.remaining_total;
  var when = upcoming.days_until === 0 ? App.t("home.event.today") : App.t("home.event.days_left", { days: upcoming.days_until });

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.event.title")) + "</h2>" +
    '<button type="button" class="link" data-goto="plan:events">' + App.esc(App.t("common.view_all")) + "</button></div>" +
    '<div class="spread"><span>' + App.esc(upcoming.name) + '</span>' +
    '<span class="row-amount">' + App.formatDong(upcoming.remaining_total) + "</span></div>" +
    '<p class="small muted">' + App.esc(upcoming.event_date) + " · " + App.esc(when) + " · " + App.esc(App.t("home.event.owed_suffix")) + "</p>" +
    '<p class="tiny ' + (affordable ? "muted" : "amount-out") + '">' +
    App.esc(affordable ? App.t("home.event.affordable") : App.t("home.event.not_affordable")) +
    "</p></section>";
};

// Where the money actually went this period, as proportion rather than a
// list of numbers - the one question a list of transactions answers slowly.
// Children roll up into their parent, so this reads at the level people
// actually budget at.
App.renderBreakdownCard = function (data) {
  var concentration = data.metrics.concentration;
  if (!concentration.has_data || !concentration.breakdown) return "";
  var rows = concentration.breakdown.slice(0, 6);
  if (rows.length < 2) return "";

  // One stacked bar reads the split instantly; the list underneath carries
  // the exact figures, since a bar segment can't be read to the đồng.
  var palette = ["var(--out)", "var(--warn)", "var(--brand)", "var(--transfer)", "var(--in)", "var(--ink-faint)"];
  var segments = rows.map(function (row, index) {
    return '<div style="width:' + row.pct.toFixed(2) + "%;background:" + palette[index % palette.length] +
      '" title="' + App.esc(row.category_name) + '"></div>';
  }).join("");

  var list = rows.map(function (row, index) {
    return '<div class="kv">' +
      '<dt><span class="legend-dot" style="background:' + palette[index % palette.length] + '"></span>' +
      App.esc(row.category_name) + "</dt>" +
      "<dd>" + App.formatDong(row.amount) + ' <span class="faint">· ' + App.formatPct(row.pct) + "</span></dd>" +
      "</div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.breakdown.title")) + "</h2>" +
    '<span class="small muted num">' + App.formatDong(concentration.total) + "</span></div>" +
    '<div class="stackbar">' + segments + "</div>" +
    '<dl class="stack-tight">' + list + "</dl>" +
    "</section>";
};

App.renderTrendCard = function (data) {
  var periods = (data.metrics.savings_trend.periods || []).filter(function (p) { return p.rate !== null; });
  if (periods.length < 2) return "";

  var trend = data.metrics.savings_trend.trend;

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.trend.title")) + "</h2>" +
    '<span class="small muted">' + App.esc(trend ? App.label("trend", trend) : "") + "</span></div>" +
    App.sparkline(periods.map(function (p) { return p.rate; })) +
    '<div class="spread tiny muted">' +
      "<span>" + App.esc(periods[0].period_id) + " · " + App.formatPct(periods[0].rate) + "</span>" +
      "<span>" + App.esc(periods[periods.length - 1].period_id) + " · " + App.formatPct(periods[periods.length - 1].rate) + "</span>" +
    "</div></section>";
};

App.renderAccountsCard = function (data) {
  var rows = data.accounts.map(function (account) {
    return '<div class="row">' +
      '<span class="row-icon">' + App.icon(App.ACCOUNT_ICONS[account.type] || "wallet") + "</span>" +
      '<div class="row-main"><span class="row-title">' + App.esc(account.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.label("account_type", account.type)) +
      (account.is_liquid ? "" : " · " + App.esc(App.t("home.accounts.not_liquid_suffix"))) + "</span></div>" +
      '<div class="row-end"><span class="row-amount">' + App.formatDong(account.balance) + "</span></div>" +
      "</div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.accounts.title")) + "</h2>" +
    '<button type="button" class="link" data-goto="settings">' + App.esc(App.t("common.manage")) + "</button></div>" +
    '<div class="rows">' + (rows || App.emptyState(App.t("home.accounts.empty"))) + "</div></section>";
};

// THIET-KE.md 4.4's 50/30/20 split, for the current period. The reference
// bands are shown next to the real numbers rather than as a pass/fail - the
// rule is a rough guide, and a red "you failed" on a rule of thumb would be
// louder than the rule deserves.
App.renderBalanceCard = function (data) {
  var balance = data.metrics.balance_50_30_20;
  if (!balance.has_data) return "";

  function line(label, value, pct, target, modifier) {
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(label) + "</span>" +
      '<span class="bar-figures">' + App.formatDong(value) + " · " + App.formatPct(pct) + "</span></div>" +
      App.track(pct, modifier) +
      '<p class="tiny faint">' + App.esc(App.t("home.balance5030.reference", { pct: target })) + "</p></div>";
  }

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("home.balance5030.title")) + "</h2>" +
    '<span class="small muted">' + App.esc(App.t("home.balance5030.this_period")) + "</span></div>" +
    line(App.t("home.balance5030.essential"), balance.essential, balance.essential_pct, 50, "") +
    line(App.t("home.balance5030.optional"), balance.optional, balance.optional_pct, 30, balance.optional_pct > 30 ? "is-warn" : "") +
    line(App.t("home.balance5030.kept"), balance.income - balance.essential - balance.optional - balance.unclassified,
      balance.saving_pct, 20, balance.saving_pct >= 20 ? "is-good" : "is-warn") +
    (balance.unclassified > 0
      ? '<p class="tiny muted">' + App.esc(App.t("home.balance5030.unclassified", { amount: App.formatDong(balance.unclassified) })) + "</p>"
      : "") +
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

App.renderDashboard = function (data) {
  if (data.transaction_count === 0) {
    return App.renderFirstRunCard(data) + App.renderAccountsCard(data);
  }
  return App.renderAlerts(data.alerts) +
    App.renderHero(data) +
    '<section class="ai-panel hidden" id="ai-daily"></section>' +
    App.renderMetrics(data) +
    App.renderBudgetReminders(data) +
    App.renderGoalsSummary(data) +
    App.renderEventCard(data) +
    App.renderBalanceCard(data) +
    App.renderBreakdownCard(data) +
    App.renderTrendCard(data) +
    App.renderAccountsCard(data);
};

// ================================================================ sổ (list)

App.renderTransactionRows = function (transactions) {
  if (transactions.length === 0) return App.emptyState(App.t("ledger.no_match"));

  var html = "";
  var lastDate = null;
  transactions.forEach(function (tx) {
    var date = App.dateOnly(tx.occurred_at);
    if (date !== lastDate) {
      html += '<p class="date-head">' + App.esc(App.formatDateHeading(date)) + "</p>";
      lastDate = date;
    }
    var kind = tx.is_transfer ? "transfer" : tx.direction;
    var amountClass = tx.is_transfer ? "amount-transfer" : (tx.direction === "in" ? "amount-in" : "amount-out");
    var sign = tx.is_transfer ? "" : (tx.direction === "in" ? "+" : "−");
    var title = tx.description || tx.category_name || (tx.is_transfer ? App.t("ledger.transfer_title") : App.t("common.no_description_row"));
    var meta = [tx.account_name, tx.category_name, tx.source === "recurring" ? App.t("common.recurring_tag") : null]
      .filter(Boolean).join(" · ");
    var glyph = tx.is_transfer ? "swap" : App.categoryIconName(tx.category_name || title);

    html += '<div class="row">' +
      '<span class="row-icon dir-' + kind + '">' + App.icon(glyph) + "</span>" +
      '<div class="row-main"><span class="row-title">' + App.esc(title) + "</span>" +
      '<span class="row-meta">' + App.esc(meta) + "</span></div>" +
      '<div class="row-end"><span class="row-amount ' + amountClass + '">' + sign + App.formatVnd(tx.amount) + "</span>" +
      '<span class="row-actions">' +
        '<button type="button" class="link" data-edit-tx="' + App.esc(tx.id) + '">' + App.esc(App.t("common.edit")) + "</button>" +
        '<button type="button" class="link link-danger" data-delete-tx="' + App.esc(tx.id) + '">' + App.esc(App.t("common.delete")) + "</button>" +
      "</span></div></div>";
  });
  return html;
};

// ============================================================ kế hoạch (plan)

// Each planning section gets an icon, a title and one line saying what
// question it answers. Without it the tab is a row of chips above a bare
// form, and nothing on screen tells you why you'd open "Định kỳ" over
// "Dự báo" - which is exactly how it read before.
// Values are i18n KEYS, not literal text, so a language switch just needs a
// re-render (planHeader/renderPlanHub call App.t on these at render time).
App.PLAN_META = {
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

App.renderBudgetPlan = function (data) {
  var expenseCategories = data.categories.filter(function (c) { return c.kind === "expense"; });
  var budgetByCategory = {};
  data.budget_statuses.forEach(function (status) { budgetByCategory[status.category_id] = status; });

  var totalBudget = data.budget_statuses.reduce(function (sum, s) { return sum + s.amount; }, 0);
  var totalSpent = data.budget_statuses.reduce(function (sum, s) { return sum + s.spent; }, 0);
  var goalPerPeriod = data.goals.reduce(function (sum, g) { return g.is_overdue ? sum : sum + g.required_per_period; }, 0);

  var rows = expenseCategories.map(function (category) {
    var status = budgetByCategory[category.id];
    var suggestion = data.budget_suggestions[category.id];
    var value = status ? status.amount : "";
    var hint = status
      ? App.t("plan.budget.spent_hint", { spent: App.formatDong(status.spent), pct: App.formatPct(status.pct_used) })
      : (suggestion ? App.t("plan.budget.suggested_hint", { amount: App.formatDong(suggestion) }) : App.t("plan.budget.no_suggestion"));

    var bar = status
      ? App.track(status.pct_used, status.over_budget ? "is-over" : (status.pct_used > 85 ? "is-warn" : ""))
      : "";

    return '<div class="bar-item">' +
      '<div class="bar-top"><label class="grow" for="budget-' + App.esc(category.id) + '">' + App.esc(category.name) + "</label>" +
      (suggestion && !status
        ? '<button type="button" class="link" data-apply-suggestion="' + App.esc(category.id) + '" data-amount="' + App.esc(suggestion) + '">' + App.esc(App.t("common.use_suggestion")) + "</button>"
        : "") +
      "</div>" +
      '<input type="text" inputmode="numeric" id="budget-' + App.esc(category.id) + '" data-budget-input="' + App.esc(category.id) + '"' +
      ' value="' + App.esc(value === "" ? "" : App.formatVnd(value)) + '" placeholder="' + App.esc(App.t("plan.budget.blank_placeholder")) + '">' +
      bar +
      '<p class="tiny muted">' + App.esc(hint) + "</p>" +
      "</div>";
  }).join("");

  // The real date range, not the raw "2026-07" id: a period id LOOKS like a
  // calendar month and isn't one, which is exactly the confusion to avoid.
  var periodNav = '<div class="spread">' +
    '<button type="button" class="link" data-period-shift="-1">' + App.esc(App.t("plan.budget.prev_period")) + "</button>" +
    '<span class="small"><b class="num">' + App.esc(App.formatPeriodRange(data.period)) + "</b>" +
    (data.period.is_current ? ' <span class="faint">' + App.esc(App.t("plan.budget.current_period_tag")) + "</span>" : "") + "</span>" +
    '<button type="button" class="link" data-period-shift="1">' + App.esc(App.t("plan.budget.next_period")) + "</button>" +
    "</div>";

  var context = goalPerPeriod > 0
    ? '<p class="tiny muted">' + App.esc(App.t("plan.budget.goal_context", { amount: App.formatDong(goalPerPeriod) })) + "</p>"
    : "";

  return '<section class="card">' + periodNav +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("plan.budget.total_budget")) + "</dt><dd>" + App.formatDong(totalBudget) + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("plan.budget.total_spent")) + "</dt><dd>" + App.formatDong(totalSpent) + "</dd></div>" +
    "</dl>" + context + "</section>" +
    '<section class="card"><h2>' + App.esc(App.t("plan.budget.per_category_title")) + "</h2>" +
    (rows || App.emptyState(App.t("plan.budget.no_categories"))) +
    '<button type="button" id="save-budgets">' + App.esc(App.t("plan.budget.save_button", { period: data.period.id })) + "</button>" +
    '<div id="budget-message"></div></section>';
};

App.renderGoalsPlan = function (data) {
  var items = data.goals.map(function (goal) {
    var modifier = goal.is_overdue ? "is-over" : (goal.is_off_track ? "is-warn" : "is-good");
    var status = goal.is_overdue ? App.t("plan.goals.overdue") : (goal.is_off_track ? App.t("plan.goals.off_track") : App.t("plan.goals.on_track"));
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(goal.name) + "</span>" +
      '<span class="bar-figures">' + App.formatVnd(goal.current_balance) + " / " + App.formatVnd(goal.target_amount) + " đ</span></div>" +
      App.track(goal.progress_pct, modifier) +
      '<div class="spread tiny muted"><span>' + App.esc(App.t("plan.goals.progress_line", {
        status: status, periods: goal.periods_remaining, amount: App.formatVnd(goal.required_per_period),
      })) + "</span>" +
      '<button type="button" class="link link-danger" data-hide-goal="' + App.esc(goal.id) + '">' + App.esc(App.t("common.hide")) + "</button></div>" +
      '<p class="tiny faint">' + App.esc(App.t("plan.goals.tracked_via", { account: goal.account_name, deadline: goal.deadline })) + "</p>" +
      "</div>";
  }).join("");

  var aiButton = data.goals.length >= 2
    ? '<button type="button" class="secondary small" id="ai-goal-priority">' + App.esc(App.t("plan.goals.ask_ai")) + "</button>" +
      '<div class="ai-panel hidden" id="ai-goals"></div>'
    : "";

  var emergencyHint = data.money.emergency_fund_target
    ? '<p class="tiny muted">' + App.esc(App.t("plan.goals.emergency_hint", { amount: App.formatDong(data.money.emergency_fund_target) })) + "</p>"
    : "";

  return '<section class="card">' +
    '<div class="card-head"><h2>' + App.esc(App.t("plan.goals.active_title")) + "</h2></div>" +
    (items || App.emptyState(App.t("plan.goals.none"))) + aiButton + "</section>" +
    '<section class="card"><h2>' + App.esc(App.t("plan.goals.add_title")) + '</h2><form id="goal-form">' +
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
    "</form></section>";
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

// Review-before-save is the whole design. The model produces candidates; this
// screen is where a human confirms them, and only then does anything get
// written. Never let an image write straight into the ledger.
App.renderImportCandidates = function (data, candidates) {
  if (candidates.length === 0) {
    return '<p class="notice notice-info">' + App.esc(App.t("import.no_candidates")) + "</p>";
  }

  var rows = candidates.map(function (candidate, index) {
    var kind = candidate.direction === "in" ? "income" : "expense";
    return '<div class="bar-item" data-candidate="' + index + '">' +
      '<label class="inline" style="justify-content:space-between">' +
        '<span class="inline"><input type="checkbox" data-cand-use checked style="width:auto;min-height:0"> ' +
        '<b class="num ' + (candidate.direction === "in" ? "amount-in" : "amount-out") + '">' +
        (candidate.direction === "in" ? "+" : "−") + App.formatVnd(candidate.amount) + "</b></span>" +
        '<span class="segmented" style="grid-auto-columns:auto">' +
          '<input type="radio" name="dir-' + index + '" value="out" data-cand-dir id="cd-out-' + index + '"' +
          (candidate.direction === "out" ? " checked" : "") + '><label for="cd-out-' + index + '">' + App.esc(App.t("dialog.edit_tx.direction_out")) + "</label>" +
          '<input type="radio" name="dir-' + index + '" value="in" data-cand-dir id="cd-in-' + index + '"' +
          (candidate.direction === "in" ? " checked" : "") + '><label for="cd-in-' + index + '">' + App.esc(App.t("dialog.edit_tx.direction_in")) + "</label>" +
        "</span>" +
      "</label>" +
      '<input type="text" inputmode="numeric" data-cand-amount value="' + App.esc(App.formatVnd(candidate.amount)) + '" aria-label="' + App.esc(App.t("import.amount_aria")) + '">' +
      '<input type="text" data-cand-note value="' + App.esc(candidate.note) + '" placeholder="' + App.esc(App.t("import.note_placeholder")) + '" aria-label="' + App.esc(App.t("import.note_aria")) + '">' +
      '<select data-cand-account aria-label="' + App.esc(App.t("import.account_aria")) + '">' + App.accountOptions(data.accounts, null, true) + "</select>" +
      '<select data-cand-category aria-label="' + App.esc(App.t("import.category_aria")) + '">' + App.categoryOptions(data.categories, kind, candidate.category_id) + "</select>" +
      '<input type="hidden" data-cand-ref value="' + App.esc(candidate.external_ref) + '">' +
      "</div>";
  }).join("");

  return '<p class="small muted">' + App.t("import.summary", { n: candidates.length }) + "</p>" +
    rows +
    '<button type="button" id="save-import">' + App.esc(App.t("import.save_button")) + "</button>" +
    '<div id="import-save-message"></div>';
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

  return '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(App.t("plan.income.reliable_title")) + "</h2></div>" +
      '<p class="tiny muted">' + App.esc(App.t("plan.income.reliable_intro")) + "</p>" +
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

App.renderForecastPlan = function () {
  return '<section class="card">' +
    "<h2>" + App.esc(App.t("plan.forecast.title")) + "</h2>" +
    '<p class="tiny muted">' + App.esc(App.t("plan.forecast.intro")) + "</p>" +
    '<label class="inline small"><input type="checkbox" id="forecast-goals" style="width:auto;min-height:0"> ' + App.esc(App.t("plan.forecast.include_goals")) + "</label>" +
    '<label class="inline small"><input type="checkbox" id="forecast-reliable" style="width:auto;min-height:0"> ' + App.esc(App.t("plan.forecast.reliable_income_only")) + "</label>" +
    '<p class="tiny faint">' + App.esc(App.t("plan.forecast.events_note")) + "</p>" +
    '<button type="button" class="secondary" id="run-forecast">' + App.esc(App.t("plan.forecast.run")) + "</button>" +
    '<div id="forecast-result"></div></section>';
};

App.renderSimulationPlan = function () {
  return '<section class="card">' +
    "<h2>" + App.esc(App.t("plan.simulate.title")) + "</h2>" +
    '<p class="tiny muted">' + App.esc(App.t("plan.simulate.intro")) + "</p>" +
    '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.item_label")) + "</span>" +
    '<input type="text" id="sim-name" placeholder="' + App.esc(App.t("plan.simulate.item_placeholder")) + '"></label>' +
    '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.price_label")) + "</span>" +
    '<input type="text" inputmode="numeric" id="sim-amount" class="amount-input" placeholder="' + App.esc(App.t("plan.simulate.price_placeholder")) + '"></label>' +
    '<label class="field"><span class="field-label">' + App.esc(App.t("plan.simulate.maintenance_label")) + "</span>" +
    '<input type="text" inputmode="numeric" id="sim-maintenance" placeholder="' + App.esc(App.t("plan.simulate.maintenance_placeholder")) + '"></label>' +
    '<button type="button" id="run-simulation">' + App.esc(App.t("plan.simulate.run")) + "</button>" +
    '<div id="simulation-result"></div></section>';
};

App.renderScenarios = function (result) {
  var rows = result.scenarios.map(function (scenario) {
    var when;
    if (scenario.first_negative) {
      when = App.t("plan.simulate.negative_from", { period: scenario.period_labels[scenario.first_negative - 1], n: scenario.first_negative });
    } else if (scenario.first_below_threshold) {
      when = App.t("plan.simulate.below_threshold_from", { period: scenario.period_labels[scenario.first_below_threshold - 1] });
    } else {
      when = App.t("plan.simulate.never_breaks");
    }
    var isBaseline = scenario.key === "none";
    return '<div class="bar-item"' + (isBaseline ? ' style="opacity:0.75"' : "") + ">" +
      '<div class="bar-top"><span>' + App.esc(scenario.label) + (isBaseline ? App.esc(App.t("plan.simulate.compare_tag")) : "") + "</span>" +
      '<span class="chip chip-' + (scenario.traffic_light === "green" ? "vung" : scenario.traffic_light === "yellow" ? "mong_manh" : "nguy_hiem") + '">' +
      App.esc(App.label("traffic_light", scenario.traffic_light)) + "</span></div>" +
      '<p class="tiny muted">' + App.esc(when) + "</p>" +
      '<p class="tiny faint num">' + App.esc(App.t("plan.simulate.floor_label", { amount: App.formatDong(scenario.lowest_balance) })) + "</p>" +
      "</div>";
  }).join("");

  return '<div class="stack">' +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>' + App.esc(App.t("plan.simulate.total_cost")) + "</dt><dd>" + App.formatDong(result.total_cost) + "</dd></div>" +
      '<div class="kv"><dt>' + App.esc(App.t("plan.simulate.current_balance")) + "</dt><dd>" + App.formatDong(result.starting_balance) + "</dd></div>" +
    "</dl>" +
    App.lineChart(result.labels, result.baseline_series) +
    '<p class="tiny faint">' + App.esc(App.t("plan.simulate.chart_footnote")) + "</p>" +
    rows +
    '<button type="button" class="secondary small" id="ai-simulation">' + App.esc(App.t("plan.simulate.ask_ai")) + "</button>" +
    '<div class="ai-panel hidden" id="ai-sim-panel"></div>' +
    "</div>";
};

// =============================================================== cài đặt

App.renderSettings = function (data) {
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

  return appearanceCard + languageCard +
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
