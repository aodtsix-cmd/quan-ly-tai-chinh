/* =========================================================================
   views.js - pure render functions. Each takes state and returns an HTML
   string; none of them touch the network or hold state of their own, so a
   view can always be re-rendered from scratch after any change.
   ========================================================================= */

var App = window.App;

App.HEALTH_LABELS = {
  nguy_hiem: "Nguy hiểm",
  mong_manh: "Mong manh",
  on: "Ổn",
  vung: "Vững",
};

App.HEALTH_BLURB = {
  nguy_hiem: "Quỹ dự phòng gần như không còn. Ưu tiên cắt chi và giữ tiền mặt.",
  mong_manh: "Có đệm nhưng mỏng. Một khoản bất ngờ là đủ để lệch kế hoạch.",
  on: "Đủ đệm cho vài kỳ. Có thể bắt đầu nghĩ tới mục tiêu dài hơn.",
  vung: "Nền móng chắc. Tiền đang làm việc thay vì chỉ nằm chờ.",
};

App.ACCOUNT_TYPES = {
  bank: "Ngân hàng",
  ewallet: "Ví điện tử",
  cash: "Tiền mặt",
  credit_card: "Thẻ tín dụng",
  savings: "Sổ tiết kiệm",
};

App.FREQUENCIES = {
  weekly: "Hằng tuần",
  monthly: "Hằng tháng",
  quarterly: "Hằng quý",
  yearly: "Hằng năm",
};

App.GOAL_TYPES = {
  emergency_fund: "Quỹ khẩn cấp",
  savings: "Tiết kiệm",
  investment: "Đầu tư",
  medical: "Y tế",
  custom: "Khác",
};

// ------------------------------------------------------------ small pieces

App.healthChip = function (level) {
  if (!level) return '<span class="chip chip-neutral"><span class="chip-dot"></span>Chưa đủ dữ liệu</span>';
  return '<span class="chip chip-' + level + '"><span class="chip-dot"></span>' + App.HEALTH_LABELS[level] + "</span>";
};

App.track = function (pct, modifier) {
  var width = Math.max(0, Math.min(Number(pct) || 0, 100));
  return '<div class="track"><div class="track-fill ' + (modifier || "") + '" style="width:' + width + '%"></div></div>';
};

App.metricTile = function (label, value, note) {
  return '<div class="metric">' +
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
  var html = placeholder === false ? "" : '<option value="">' + App.esc(placeholder || "— Chưa phân loại —") + "</option>";

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

App.accountOptions = function (accounts, selectedId, withBalance) {
  return accounts.map(function (account) {
    var label = account.name + (withBalance ? " · " + App.formatCompact(account.balance) + " đ" : "");
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
      '<button type="button" class="link" data-dismiss-alert="' + App.esc(alert.code) + '">Đã xem</button>' +
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
    moneyLabel = "ngân sách";
  } else {
    // No budget set yet: fall back to this period's spend against the recent
    // average period spend, so the ribbon still says something true.
    var periods = data.metrics.savings_trend.periods || [];
    if (periods.length > 0) {
      var avg = periods.reduce(function (sum, p) { return sum + p.expense; }, 0) / periods.length;
      if (avg > 0) {
        moneyPct = (data.metrics.current_savings_rate.expense / avg) * 100;
        moneyLabel = "mức chi trung bình một kỳ";
      }
    }
  }

  var rows =
    '<div class="ribbon-row">' +
      '<span class="ribbon-label">Thời gian</span>' +
      App.track(timePct, "is-time") +
      '<span class="ribbon-value">' + Math.round(timePct) + "%</span>" +
    "</div>";

  var note;
  if (moneyPct === null) {
    note = "Đặt ngân sách cho kỳ này để so nhịp tiêu với nhịp thời gian.";
  } else {
    var modifier = moneyPct > 100 ? "is-over" : (moneyPct > timePct + 10 ? "is-warn" : (moneyPct < timePct - 10 ? "is-good" : ""));
    rows +=
      '<div class="ribbon-row">' +
        '<span class="ribbon-label">Tiền</span>' +
        App.track(moneyPct, modifier) +
        '<span class="ribbon-value">' + Math.round(moneyPct) + "%</span>" +
      "</div>";
    // Kept strictly factual. The judgement ("đang tiêu nhanh hơn nhịp") is
    // the health score's job, right above - saying it in both places reads
    // as the app repeating itself.
    note = "Đã đi " + Math.round(timePct) + "% thời gian của kỳ, đã tiêu " +
      Math.round(moneyPct) + "% " + moneyLabel + ".";
  }

  return '<div class="ribbon">' + rows + '<p class="ribbon-note">' + App.esc(note) + "</p></div>";
};

App.renderHero = function (data) {
  var health = data.health;
  var blurb = health.has_data
    ? App.HEALTH_BLURB[health.level]
    : "Ghi thêm vài giao dịch ở danh mục thiết yếu để tính được sức khỏe tài chính.";

  var reasons = (health.downgraded_reasons || []).length
    ? '<p class="small"><b>Điểm bị hạ vì:</b> <span class="muted">' +
      App.esc(health.downgraded_reasons.join(" ")) + "</span></p>"
    : "";

  return '<section class="card hero">' +
    '<div class="hero-top">' +
      "<div>" +
        '<span class="eyebrow">Tiền có thể dùng</span>' +
        '<p class="hero-balance">' + App.formatVnd(data.money.liquid_balance) + '<span class="unit">đ</span></p>' +
      "</div>" +
      App.healthChip(health.has_data ? health.level : null) +
    "</div>" +
    '<div class="hero-sub small muted">' +
      "<span>Tổng tài sản <b class=\"num\">" + App.formatCompact(data.money.net_worth) + " đ</b></span>" +
      (health.runway_months !== null
        ? "<span>Cầm cự <b class=\"num\">" + App.formatNumber(health.runway_months) + "</b> kỳ nếu mất thu nhập</span>"
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
    App.metricTile("Cầm cự được",
      money.survival_days !== null ? App.formatNumber(money.survival_days, 0) + '<span class="u">ngày</span>' : "—",
      money.survival_days !== null ? "với mức chi 30 ngày qua" : "chưa có dữ liệu chi"),

    App.metricTile("Dự báo cuối kỳ",
      '<span class="' + (money.at_risk ? "amount-out" : "") + '">' + App.formatCompact(money.forecast_balance) + " đ</span>",
      "còn " + data.period.days_remaining + " ngày"),

    App.metricTile("Tiết kiệm kỳ này",
      metrics.current_savings_rate.has_data ? App.formatPct(metrics.current_savings_rate.rate) : "—",
      metrics.current_savings_rate.has_data ? "phần thu giữ lại được" : "chưa ghi thu nhập"),

    App.metricTile("Ngốn tiền nhất",
      metrics.concentration.has_data
        ? '<span class="as-text">' + App.esc(metrics.concentration.category_name) + "</span>"
        : "—",
      metrics.concentration.has_data ? App.formatPct(metrics.concentration.pct) + " chi tiêu kỳ này" : "chưa có chi tiêu"),

    App.metricTile("Chi cố định",
      metrics.rigidity.has_data ? App.formatPct(metrics.rigidity.pct) : "—",
      metrics.rigidity.has_data ? "phần thu đã bị khóa cứng" : "cần lịch sử 3 kỳ"),

    App.metricTile("Dao động thu nhập",
      metrics.income_stability.has_data ? App.formatPct(metrics.income_stability.cv_pct) : "—",
      metrics.income_stability.has_data ? "càng thấp càng đều" : "cần ít nhất 2 kỳ"),
  ];

  if (data.income_sustainability.has_data) {
    var margin = data.income_sustainability.margin;
    tiles.push(App.metricTile("Thu chắc chắn",
      '<span class="' + (margin >= 0 ? "amount-in" : "amount-out") + '">' +
      App.formatPct(data.income_sustainability.covered_pct) + "</span>",
      margin >= 0 ? "đã đủ chi thiết yếu" : "chưa đủ chi thiết yếu"));
  }

  return '<div class="metric-grid">' + tiles.join("") + "</div>";
};

App.renderBudgetReminders = function (data) {
  var statuses = data.budget_statuses.slice(0, 3);
  if (statuses.length === 0) return "";

  var items = statuses.map(function (status) {
    var text = status.over_budget
      ? "Đã vượt " + App.formatDong(-status.remaining)
      : "Còn " + App.formatDong(status.remaining) + " cho " + data.period.days_remaining + " ngày tới";
    var modifier = status.over_budget ? "is-over" : (status.pct_used > 85 ? "is-warn" : "");
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(status.category_name) + "</span>" +
      '<span class="bar-figures">' + App.formatCompact(status.spent) + " / " + App.formatCompact(status.amount) + "</span></div>" +
      App.track(status.pct_used, modifier) +
      '<p class="tiny ' + (status.over_budget ? "amount-out" : "muted") + '">' + App.esc(text) + "</p>" +
      "</div>";
  }).join("");

  var streak = data.metrics.budget_streak > 0
    ? '<p class="tiny muted">Đã ' + data.metrics.budget_streak + " kỳ liên tiếp không vượt ngân sách.</p>"
    : "";

  return '<section class="card">' +
    '<div class="card-head"><h2>Ngân sách kỳ này</h2>' +
    '<button type="button" class="link" data-goto="plan:budget">Sửa</button></div>' +
    items + streak + "</section>";
};

App.renderGoalsSummary = function (data) {
  if (data.goals.length === 0) return "";
  var behind = data.goals.filter(function (g) { return g.is_off_track || g.is_overdue; });
  var perPeriod = data.goals.reduce(function (sum, g) { return g.is_overdue ? sum : sum + g.required_per_period; }, 0);

  var note = behind.length === 0
    ? "Tất cả mục tiêu đang đúng tiến độ."
    : behind.length + " mục tiêu đang chậm: " + behind.map(function (g) { return g.name; }).join(", ") + ".";

  return '<section class="card">' +
    '<div class="card-head"><h2>Mục tiêu</h2>' +
    '<button type="button" class="link" data-goto="plan:goals">Xem tất cả</button></div>' +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>Đang theo đuổi</dt><dd>' + data.goals.length + "</dd></div>" +
      '<div class="kv"><dt>Cần dành mỗi kỳ</dt><dd>' + App.formatDong(perPeriod) + "</dd></div>" +
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
  var when = upcoming.days_until === 0 ? "hôm nay" : "còn " + upcoming.days_until + " ngày";

  return '<section class="card">' +
    '<div class="card-head"><h2>Sự kiện sắp tới</h2>' +
    '<button type="button" class="link" data-goto="plan:events">Xem tất cả</button></div>' +
    '<div class="spread"><span>' + App.esc(upcoming.name) + '</span>' +
    '<span class="row-amount">' + App.formatDong(upcoming.remaining_total) + "</span></div>" +
    '<p class="small muted">' + App.esc(upcoming.event_date) + " · " + App.esc(when) + " · còn phải trả</p>" +
    '<p class="tiny ' + (affordable ? "muted" : "amount-out") + '">' +
    (affordable
      ? "Số dư hiện tại thừa sức lo khoản này."
      : "Số dư hiện tại chưa đủ cho khoản này — cần dành thêm trước ngày đó.") +
    "</p></section>";
};

App.renderTrendCard = function (data) {
  var periods = (data.metrics.savings_trend.periods || []).filter(function (p) { return p.rate !== null; });
  if (periods.length < 2) return "";

  var labels = { improving: "đang cải thiện", declining: "đang đi xuống", stable: "đi ngang" };
  var trend = data.metrics.savings_trend.trend;

  return '<section class="card">' +
    '<div class="card-head"><h2>Tỷ lệ tiết kiệm</h2>' +
    '<span class="small muted">' + App.esc(labels[trend] || "") + "</span></div>" +
    App.sparkline(periods.map(function (p) { return p.rate; })) +
    '<div class="spread tiny muted">' +
      "<span>" + App.esc(periods[0].period_id) + " · " + App.formatPct(periods[0].rate) + "</span>" +
      "<span>" + App.esc(periods[periods.length - 1].period_id) + " · " + App.formatPct(periods[periods.length - 1].rate) + "</span>" +
    "</div></section>";
};

App.renderAccountsCard = function (data) {
  var rows = data.accounts.map(function (account) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">' + App.esc(account.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.ACCOUNT_TYPES[account.type] || account.type) +
      (account.is_liquid ? "" : " · không tính vào tiền có thể dùng") + "</span></div>" +
      '<div class="row-end"><span class="row-amount">' + App.formatDong(account.balance) + "</span></div>" +
      "</div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>Tài khoản</h2>' +
    '<button type="button" class="link" data-goto="settings">Quản lý</button></div>' +
    '<div class="rows">' + (rows || App.emptyState("Chưa có tài khoản nào.")) + "</div></section>";
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
      '<span class="bar-figures">' + App.formatCompact(value) + " đ · " + App.formatPct(pct) + "</span></div>" +
      App.track(pct, modifier) +
      '<p class="tiny faint">Tham chiếu: khoảng ' + target + "%</p></div>";
  }

  return '<section class="card">' +
    '<div class="card-head"><h2>Cân đối 50/30/20</h2>' +
    '<span class="small muted">kỳ này</span></div>' +
    line("Thiết yếu", balance.essential, balance.essential_pct, 50, "") +
    line("Tùy chọn", balance.optional, balance.optional_pct, 30, balance.optional_pct > 30 ? "is-warn" : "") +
    line("Còn giữ lại", balance.income - balance.essential - balance.optional - balance.unclassified,
      balance.saving_pct, 20, balance.saving_pct >= 20 ? "is-good" : "is-warn") +
    (balance.unclassified > 0
      ? '<p class="tiny muted">' + App.formatDong(balance.unclassified) +
        " chưa xếp được vào nhóm nào — thêm “thiết yếu/tùy chọn” cho danh mục ở Cài đặt để con số này chính xác hơn.</p>"
      : "") +
    "</section>";
};

// First run: the dashboard is a grid of dashes and says nothing useful, so
// lead with what to do instead of what isn't known yet.
App.renderFirstRunCard = function (data) {
  var setupNote = data.auto_setup && data.auto_setup.created.length
    ? "Đã tự dựng " + data.auto_setup.created.length + " tab trong Google Sheet của bạn" +
      (data.auto_setup.seeded && data.auto_setup.seeded.categories
        ? " và nạp sẵn " + data.auto_setup.seeded.categories + " danh mục."
        : ".")
    : "Bảng tính đã sẵn sàng.";

  return '<section class="card">' +
    '<span class="eyebrow">Bắt đầu</span>' +
    "<h1>Sổ của bạn đã sẵn sàng</h1>" +
    '<p class="small muted">' + App.esc(setupNote) + " Ghi vài giao dịch là các chỉ số bên dưới bắt đầu có ý nghĩa.</p>" +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>1. Đặt số dư thật cho từng tài khoản</dt><dd></dd></div>' +
      '<div class="kv"><dt>2. Ghi giao dịch hằng ngày ở tab Nhập</dt><dd></dd></div>' +
      '<div class="kv"><dt>3. Đặt ngân sách kỳ này ở tab Kế hoạch</dt><dd></dd></div>' +
    "</dl>" +
    '<div class="button-row">' +
      '<button type="button" data-goto="add">Ghi giao dịch đầu tiên</button>' +
      '<button type="button" class="secondary" data-goto="settings">Sửa số dư</button>' +
    "</div>" +
    '<p class="tiny faint">Các chỉ số như số kỳ cầm cự hay tỷ lệ tiết kiệm cần ít nhất một kỳ đã khép lại mới tính được — ' +
    "chúng sẽ tự hiện ra, không cần làm gì thêm.</p>" +
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
    App.renderTrendCard(data) +
    App.renderAccountsCard(data);
};

// ================================================================ sổ (list)

App.renderTransactionRows = function (transactions) {
  if (transactions.length === 0) return App.emptyState("Không có giao dịch nào khớp.");

  var html = "";
  var lastDate = null;
  transactions.forEach(function (tx) {
    var date = App.dateOnly(tx.occurred_at);
    if (date !== lastDate) {
      html += '<p class="date-head">' + App.esc(App.formatDateHeading(date)) + "</p>";
      lastDate = date;
    }
    var amountClass = tx.is_transfer ? "amount-transfer" : (tx.direction === "in" ? "amount-in" : "amount-out");
    var sign = tx.is_transfer ? "" : (tx.direction === "in" ? "+" : "−");
    var title = tx.description || tx.category_name || (tx.is_transfer ? "Chuyển khoản" : "Không ghi chú");
    var meta = [tx.account_name, tx.category_name, tx.source === "recurring" ? "định kỳ" : null]
      .filter(Boolean).join(" · ");

    html += '<div class="row">' +
      '<div class="row-main"><span class="row-title">' + App.esc(title) + "</span>" +
      '<span class="row-meta">' + App.esc(meta) + "</span></div>" +
      '<div class="row-end"><span class="row-amount ' + amountClass + '">' + sign + App.formatVnd(tx.amount) + "</span>" +
      '<span class="row-actions">' +
        '<button type="button" class="link" data-edit-tx="' + App.esc(tx.id) + '">Sửa</button>' +
        '<button type="button" class="link link-danger" data-delete-tx="' + App.esc(tx.id) + '">Xóa</button>' +
      "</span></div></div>";
  });
  return html;
};

// ============================================================ kế hoạch (plan)

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
      ? "Đã tiêu " + App.formatCompact(status.spent) + " đ · " + App.formatPct(status.pct_used)
      : (suggestion ? "Gợi ý từ lịch sử: " + App.formatCompact(suggestion) + " đ" : "Chưa có gợi ý");

    var bar = status
      ? App.track(status.pct_used, status.over_budget ? "is-over" : (status.pct_used > 85 ? "is-warn" : ""))
      : "";

    return '<div class="bar-item">' +
      '<div class="bar-top"><label class="grow" for="budget-' + App.esc(category.id) + '">' + App.esc(category.name) + "</label>" +
      (suggestion && !status
        ? '<button type="button" class="link" data-apply-suggestion="' + App.esc(category.id) + '" data-amount="' + App.esc(suggestion) + '">Dùng gợi ý</button>'
        : "") +
      "</div>" +
      '<input type="text" inputmode="numeric" id="budget-' + App.esc(category.id) + '" data-budget-input="' + App.esc(category.id) + '"' +
      ' value="' + App.esc(value) + '" placeholder="Bỏ trống nếu không đặt">' +
      bar +
      '<p class="tiny muted">' + App.esc(hint) + "</p>" +
      "</div>";
  }).join("");

  var periodNav = '<div class="spread">' +
    '<button type="button" class="link" data-period-shift="-1">← Kỳ trước</button>' +
    '<span class="small num">' + App.esc(data.period.id) + (data.period.is_current ? " (kỳ này)" : "") + "</span>" +
    '<button type="button" class="link" data-period-shift="1">Kỳ sau →</button>' +
    "</div>";

  var context = goalPerPeriod > 0
    ? '<p class="tiny muted">Các mục tiêu đang cần thêm ' + App.formatDong(goalPerPeriod) +
      " mỗi kỳ, ngoài ngân sách chi tiêu ở trên.</p>"
    : "";

  return '<section class="card">' + periodNav +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>Tổng ngân sách</dt><dd>' + App.formatDong(totalBudget) + "</dd></div>" +
      '<div class="kv"><dt>Đã tiêu</dt><dd>' + App.formatDong(totalSpent) + "</dd></div>" +
    "</dl>" + context + "</section>" +
    '<section class="card"><h2>Hạn mức từng danh mục</h2>' +
    (rows || App.emptyState("Chưa có danh mục chi tiêu nào.")) +
    '<button type="button" id="save-budgets">Lưu ngân sách kỳ ' + App.esc(data.period.id) + "</button>" +
    '<div id="budget-message"></div></section>';
};

App.renderGoalsPlan = function (data) {
  var items = data.goals.map(function (goal) {
    var modifier = goal.is_overdue ? "is-over" : (goal.is_off_track ? "is-warn" : "is-good");
    var status = goal.is_overdue ? "Đã quá hạn" : (goal.is_off_track ? "Chậm tiến độ" : "Đúng tiến độ");
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(goal.name) + "</span>" +
      '<span class="bar-figures">' + App.formatCompact(goal.current_balance) + " / " + App.formatCompact(goal.target_amount) + " đ</span></div>" +
      App.track(goal.progress_pct, modifier) +
      '<div class="spread tiny muted"><span>' + App.esc(status) + " · còn " + goal.periods_remaining + " kỳ · cần " +
      App.formatCompact(goal.required_per_period) + " đ/kỳ</span>" +
      '<button type="button" class="link link-danger" data-hide-goal="' + App.esc(goal.id) + '">Ẩn</button></div>' +
      '<p class="tiny faint">Theo dõi qua tài khoản ' + App.esc(goal.account_name) + " · hạn " + App.esc(goal.deadline) + "</p>" +
      "</div>";
  }).join("");

  var aiButton = data.goals.length >= 2
    ? '<button type="button" class="secondary small" id="ai-goal-priority">Hỏi AI nên ưu tiên mục tiêu nào</button>' +
      '<div class="ai-panel hidden" id="ai-goals"></div>'
    : "";

  var emergencyHint = data.money.emergency_fund_target
    ? '<p class="tiny muted">Gợi ý quỹ khẩn cấp: ' + App.formatDong(data.money.emergency_fund_target) +
      " (6 kỳ chi phí thiết yếu).</p>"
    : "";

  return '<section class="card">' +
    '<div class="card-head"><h2>Mục tiêu đang theo đuổi</h2></div>' +
    (items || App.emptyState("Chưa có mục tiêu nào.")) + aiButton + "</section>" +
    '<section class="card"><h2>Thêm mục tiêu</h2><form id="goal-form">' +
      '<label class="field"><span class="field-label">Tên mục tiêu</span>' +
      '<input type="text" name="name" placeholder="VD: Quỹ khẩn cấp" required></label>' +
      '<label class="field"><span class="field-label">Loại</span><select name="goal_type">' +
        Object.keys(App.GOAL_TYPES).map(function (key) {
          return '<option value="' + key + '">' + App.esc(App.GOAL_TYPES[key]) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">Số tiền đích</span>' +
      '<input type="text" inputmode="numeric" name="target_amount" placeholder="VD: 20tr" required></label>' +
      '<label class="field"><span class="field-label">Hạn chót</span>' +
      '<input type="date" name="deadline" required></label>' +
      '<label class="field"><span class="field-label">Tài khoản tích lũy</span>' +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, null, false) + "</select></label>" +
      emergencyHint +
      "<button type=\"submit\">Tạo mục tiêu</button>" +
      '<div id="goal-message"></div>' +
    "</form></section>";
};

App.renderRecurringPlan = function (data) {
  var rows = data.recurring.map(function (item) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">' + App.esc(item.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.FREQUENCIES[item.frequency] || item.frequency) +
      " · kế tiếp " + App.esc(item.next_due) + " · " + App.esc(item.account_name) + "</span></div>" +
      '<div class="row-end"><span class="row-amount ' + (item.direction === "in" ? "amount-in" : "amount-out") + '">' +
      (item.direction === "in" ? "+" : "−") + App.formatVnd(item.amount) + "</span>" +
      '<span class="row-actions"><button type="button" class="link link-danger" data-hide-recurring="' + App.esc(item.id) + '">Ngừng</button></span>' +
      "</div></div>";
  }).join("");

  return '<section class="card">' +
    '<div class="card-head"><h2>Khoản định kỳ</h2></div>' +
    '<p class="tiny muted">Đến hạn là tự động ghi thành giao dịch, ngay lần mở app kế tiếp.</p>' +
    '<div class="rows">' + (rows || App.emptyState("Chưa có khoản định kỳ nào.")) + "</div></section>" +
    '<section class="card"><h2>Thêm khoản định kỳ</h2><form id="recurring-form">' +
      '<label class="field"><span class="field-label">Tên</span>' +
      '<input type="text" name="name" placeholder="VD: Tiền phòng" required></label>' +
      '<div class="segmented">' +
        '<input type="radio" id="rec-out" name="direction" value="out" checked><label for="rec-out">Chi</label>' +
        '<input type="radio" id="rec-in" name="direction" value="in"><label for="rec-in">Thu</label>' +
      "</div>" +
      '<label class="field"><span class="field-label">Số tiền</span>' +
      '<input type="text" inputmode="numeric" name="amount" placeholder="VD: 3tr" required></label>' +
      '<label class="field"><span class="field-label">Tài khoản</span>' +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, null, false) + "</select></label>" +
      '<label class="field"><span class="field-label">Danh mục</span>' +
      '<select name="category_id">' + App.categoryOptions(data.categories, "expense") + "</select></label>" +
      '<label class="field"><span class="field-label">Tần suất</span><select name="frequency">' +
        Object.keys(App.FREQUENCIES).map(function (key) {
          return '<option value="' + key + '"' + (key === "monthly" ? " selected" : "") + ">" + App.esc(App.FREQUENCIES[key]) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">Lần đến hạn kế tiếp</span>' +
      '<input type="date" name="next_due" required></label>' +
      "<button type=\"submit\">Thêm khoản định kỳ</button>" +
      '<div id="recurring-message"></div>' +
    "</form></section>";
};

// Review-before-save is the whole design. The model produces candidates; this
// screen is where a human confirms them, and only then does anything get
// written. Never let an image write straight into the ledger.
App.renderImportCandidates = function (data, candidates) {
  if (candidates.length === 0) {
    return '<p class="notice notice-info">Không đọc được giao dịch nào trong ảnh. ' +
      "Thử ảnh rõ hơn, hoặc nhập tay ở trên.</p>";
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
          (candidate.direction === "out" ? " checked" : "") + '><label for="cd-out-' + index + '">Chi</label>' +
          '<input type="radio" name="dir-' + index + '" value="in" data-cand-dir id="cd-in-' + index + '"' +
          (candidate.direction === "in" ? " checked" : "") + '><label for="cd-in-' + index + '">Thu</label>' +
        "</span>" +
      "</label>" +
      '<input type="text" inputmode="numeric" data-cand-amount value="' + App.esc(candidate.amount) + '" aria-label="Số tiền">' +
      '<input type="text" data-cand-note value="' + App.esc(candidate.note) + '" placeholder="Mô tả" aria-label="Mô tả">' +
      '<select data-cand-account aria-label="Tài khoản">' + App.accountOptions(data.accounts, null, true) + "</select>" +
      '<select data-cand-category aria-label="Danh mục">' + App.categoryOptions(data.categories, kind, candidate.category_id) + "</select>" +
      '<input type="hidden" data-cand-ref value="' + App.esc(candidate.external_ref) + '">' +
      "</div>";
  }).join("");

  return '<p class="small muted">Đọc được <b>' + candidates.length + "</b> giao dịch. " +
    "Kiểm tra lại rồi bấm lưu — chưa có gì được ghi vào sổ cả.</p>" +
    rows +
    '<button type="button" id="save-import">Lưu các giao dịch đã chọn</button>' +
    '<div id="import-save-message"></div>';
};

App.renderIncomePlan = function (data) {
  var sustainability = data.income_sustainability;

  var rows = data.income_sources.map(function (source) {
    return '<div class="bar-item">' +
      '<div class="bar-top"><span>' + App.esc(source.name) + "</span>" +
      '<span class="bar-figures">' + App.formatCompact(source.expected_amount) + " đ · " + source.reliability + "%</span></div>" +
      App.track(source.reliability, source.reliability >= 80 ? "is-good" : (source.reliability >= 50 ? "" : "is-warn")) +
      '<div class="spread tiny muted"><span>Tính chắc chắn được ' + App.formatDong(source.reliable_amount) + "/kỳ</span>" +
      '<button type="button" class="link link-danger" data-hide-income="' + App.esc(source.id) + '">Ẩn</button></div>' +
      "</div>";
  }).join("");

  var summary = "";
  if (sustainability.has_data) {
    var covered = sustainability.margin >= 0;
    summary = '<dl class="stack-tight">' +
      '<div class="kv"><dt>Thu chắc chắn mỗi kỳ</dt><dd>' + App.formatDong(sustainability.reliable_income) + "</dd></div>" +
      '<div class="kv"><dt>Chi thiết yếu mỗi kỳ</dt><dd>' + App.formatDong(sustainability.essential_expense) + "</dd></div>" +
      '<div class="kv"><dt>Chênh lệch</dt><dd class="' + (covered ? "amount-in" : "amount-out") + '">' +
      (covered ? "+" : "") + App.formatDong(sustainability.margin) + "</dd></div>" +
    "</dl>" +
    '<p class="small ' + (covered ? "muted" : "amount-out") + '">' +
    (covered
      ? "Thu nhập chắc chắn đã đủ trang trải chi phí thiết yếu — phần còn lại là vùng an toàn của bạn."
      : "Thu nhập chắc chắn chưa đủ chi thiết yếu. Phần thiếu đang phải bù bằng khoản thu bấp bênh hoặc tiền tiết kiệm.") +
    "</p>";
  } else {
    summary = '<p class="small muted">Thêm nguồn thu bên dưới, và ghi đủ một kỳ chi tiêu ở danh mục thiết yếu, ' +
      "để biết thu nhập chắc chắn có đủ nuôi mức sống hiện tại không.</p>";
  }

  return '<section class="card">' +
      '<div class="card-head"><h2>Thu nhập chắc chắn</h2></div>' +
      '<p class="tiny muted">Một khoản thu <i>dự kiến</i> không nên được coi là chắc chắn chỉ vì bạn mong nó tới. ' +
      "Độ tin cậy là thứ cho phép app chiết khấu nó lại.</p>" +
      summary +
    "</section>" +
    '<section class="card">' +
      '<div class="card-head"><h2>Các nguồn thu</h2></div>' +
      (rows || App.emptyState("Chưa khai báo nguồn thu nào.")) +
    "</section>" +
    '<section class="card"><h2>Thêm nguồn thu</h2><form id="income-form">' +
      '<label class="field"><span class="field-label">Tên nguồn thu</span>' +
      '<input type="text" name="name" placeholder="VD: Lương dạy học" required></label>' +
      '<label class="field"><span class="field-label">Số tiền dự kiến mỗi kỳ</span>' +
      '<input type="text" inputmode="numeric" name="expected_amount" placeholder="VD: 8tr" required></label>' +
      '<label class="field"><span class="field-label">Độ tin cậy (%)</span>' +
      '<input type="number" name="reliability" min="0" max="100" step="5" value="100" required>' +
      '<span class="tiny faint">100 = gần như chắc chắn nhận được. 40 = việc thời vụ, tháng có tháng không.</span></label>' +
      '<button type="submit">Thêm nguồn thu</button>' +
      '<div id="income-message"></div>' +
    "</form></section>";
};

App.renderEventsPlan = function (data) {
  var upcoming = data.events.filter(function (e) { return !e.is_past; });
  var past = data.events.filter(function (e) { return e.is_past; });

  function eventCard(event) {
    var pct = event.expected_total > 0 ? (event.actual_total / event.expected_total) * 100 : 0;
    var when = event.is_past
      ? "Đã diễn ra " + Math.abs(event.days_until) + " ngày trước"
      : (event.days_until === 0 ? "Diễn ra hôm nay" : "Còn " + event.days_until + " ngày · kỳ " + event.period_id);

    var items = event.items.map(function (item) {
      return '<div class="kv">' +
        "<dt>" + App.esc(item.name) + "</dt>" +
        '<dd><input type="text" inputmode="numeric" data-event-item="' + App.esc(item.id) + '"' +
        ' value="' + (item.actual_amount ? App.esc(item.actual_amount) : "") + '"' +
        ' placeholder="' + (item.expected_amount ? "dự kiến " + App.formatCompact(item.expected_amount) : "chưa ước lượng") + '"' +
        ' style="width:8rem;min-height:2.2rem;padding:0.3rem 0.5rem;font-size:0.875rem"></dd>' +
        "</div>";
    }).join("");

    var goalPrompt = event.should_suggest_goal
      ? '<div class="notice notice-info">' +
        "<p>Sự kiện này còn " + App.formatDong(event.remaining_total) + " và cách đây " + event.periods_until +
        " kỳ. Biến nó thành mục tiêu tích lũy để dành dần mỗi kỳ?</p>" +
        '<button type="button" class="link" data-event-to-goal="' + App.esc(event.id) + '">Tạo mục tiêu cho sự kiện này</button>' +
        "</div>"
      : "";

    return '<section class="card">' +
      '<div class="card-head"><h2>' + App.esc(event.name) + "</h2>" +
      '<button type="button" class="link link-danger" data-delete-event="' + App.esc(event.id) + '">Xóa</button></div>' +
      '<p class="tiny muted">' + App.esc(event.event_date) + " · " + App.esc(when) +
      (event.linked_goal_id ? " · đã gắn mục tiêu" : "") + "</p>" +
      '<dl class="stack-tight">' +
        '<div class="kv"><dt>Dự kiến</dt><dd>' + App.formatDong(event.expected_total) + "</dd></div>" +
        '<div class="kv"><dt>Đã chi thực tế</dt><dd>' + App.formatDong(event.actual_total) + "</dd></div>" +
        '<div class="kv"><dt>Còn phải trả</dt><dd class="' + (event.remaining_total > 0 ? "amount-out" : "amount-in") + '">' +
        App.formatDong(event.remaining_total) + "</dd></div>" +
      "</dl>" +
      App.track(pct, pct > 100 ? "is-over" : "is-good") +
      goalPrompt +
      '<p class="eyebrow" style="margin-top:0.5rem">Chi thực tế từng khoản</p>' +
      '<dl class="stack-tight">' + items + "</dl>" +
      '<p class="tiny faint">Điền số thực tế khi đã chi. Phần chưa trả sẽ được trừ vào dự báo dòng tiền ở đúng kỳ diễn ra.</p>' +
      "</section>";
  }

  var templateOptions = data.event_templates.map(function (template, index) {
    return '<option value="' + index + '">' + App.esc(template.name) + "</option>";
  }).join("");

  return (upcoming.length ? upcoming.map(eventCard).join("") : '<section class="card">' +
      "<h2>Sự kiện sắp tới</h2>" + App.emptyState("Chưa có kế hoạch sự kiện nào.") +
      '<p class="tiny muted">Một chuyến đi, một đám cưới, một lần chuyển nhà — ghi ra trước để nó xuất hiện ' +
      "trong dự báo thay vì ập đến bất ngờ.</p></section>") +
    '<section class="card"><h2>Lên kế hoạch sự kiện</h2><form id="event-form">' +
      '<label class="field"><span class="field-label">Tên sự kiện</span>' +
      '<input type="text" name="name" placeholder="VD: Du lịch Đà Nẵng" required></label>' +
      '<label class="field"><span class="field-label">Ngày diễn ra</span>' +
      '<input type="date" name="event_date" required></label>' +
      '<label class="field"><span class="field-label">Dùng mẫu có sẵn</span>' +
      '<select id="event-template"><option value="">— Tự nhập từ đầu —</option>' + templateOptions + "</select>" +
      '<span class="tiny faint">Mẫu chỉ gợi ý <b>tên khoản mục</b>, không gợi ý giá — giá phụ thuộc hoàn toàn vào nơi bạn ở và hoàn cảnh.</span></label>' +
      '<p class="eyebrow" style="margin-top:0.5rem">Các khoản mục</p>' +
      '<div id="event-items"></div>' +
      '<button type="button" class="secondary small" id="add-event-item">+ Thêm khoản mục</button>' +
      '<button type="submit">Lưu kế hoạch</button>' +
      '<div id="event-message"></div>' +
    "</form></section>" +
    (past.length
      ? '<section class="card"><h2>Đã diễn ra</h2>' + past.map(function (event) {
          return '<div class="row"><div class="row-main"><span class="row-title">' + App.esc(event.name) + "</span>" +
            '<span class="row-meta">' + App.esc(event.event_date) + "</span></div>" +
            '<div class="row-end"><span class="row-amount">' + App.formatCompact(event.actual_total) + " đ</span>" +
            '<span class="row-actions"><button type="button" class="link link-danger" data-delete-event="' +
            App.esc(event.id) + '">Xóa</button></span></div></div>';
        }).join("") + "</section>"
      : "");
};

App.eventItemRow = function (name, readonly) {
  return '<div class="inline" style="gap:0.5rem;margin-bottom:0.5rem">' +
    '<input type="text" class="grow" data-item-name value="' + App.esc(name || "") + '"' +
    (readonly ? " readonly" : "") + ' placeholder="Tên khoản mục">' +
    '<input type="text" inputmode="numeric" data-item-amount placeholder="Số tiền" style="width:8rem">' +
    "</div>";
};

App.renderForecastPlan = function () {
  return '<section class="card">' +
    "<h2>Dự báo dòng tiền</h2>" +
    '<p class="tiny muted">Kéo dài mức thu/chi trung bình 3 kỳ gần nhất về phía trước, cộng dồn số dư qua từng kỳ. ' +
    "Đây là phép ngoại suy đơn giản — chưa tính mùa vụ hay biến động bất thường.</p>" +
    '<label class="inline small"><input type="checkbox" id="forecast-goals" style="width:auto;min-height:0"> Trừ cả tiền dành cho mục tiêu</label>' +
    '<label class="inline small"><input type="checkbox" id="forecast-reliable" style="width:auto;min-height:0"> Chỉ tính thu nhập chắc chắn (thay vì trung bình lịch sử)</label>' +
    '<p class="tiny faint">Sự kiện đã lên kế hoạch luôn được trừ vào đúng kỳ diễn ra.</p>' +
    '<button type="button" class="secondary" id="run-forecast">Xem dự báo 6 kỳ tới</button>' +
    '<div id="forecast-result"></div></section>';
};

App.renderSimulationPlan = function () {
  return '<section class="card">' +
    "<h2>Mô phỏng một khoản chi lớn</h2>" +
    '<p class="tiny muted">Xem trước tác động lên số dư trước khi quyết định mua.</p>' +
    '<label class="field"><span class="field-label">Món định mua</span>' +
    '<input type="text" id="sim-name" placeholder="VD: Laptop mới"></label>' +
    '<label class="field"><span class="field-label">Giá</span>' +
    '<input type="text" inputmode="numeric" id="sim-amount" class="amount-input" placeholder="VD: 25tr"></label>' +
    '<label class="field"><span class="field-label">Chi phí nuôi mỗi kỳ (nếu có)</span>' +
    '<input type="text" inputmode="numeric" id="sim-maintenance" placeholder="VD: 200k"></label>' +
    '<button type="button" id="run-simulation">Mô phỏng</button>' +
    '<div id="simulation-result"></div></section>';
};

App.LIGHT_LABELS = { green: "An toàn", yellow: "Cần cân nhắc", red: "Rủi ro" };
App.LIGHT_CLASS = { green: "chip-vung", yellow: "chip-mong_manh", red: "chip-nguy_hiem" };

App.renderScenarios = function (result) {
  var rows = result.scenarios.map(function (scenario) {
    var when;
    if (scenario.first_negative) {
      when = "Âm quỹ từ kỳ " + scenario.period_labels[scenario.first_negative - 1] +
        " (kỳ thứ " + scenario.first_negative + ").";
    } else if (scenario.first_below_threshold) {
      when = "Tụt dưới mức an toàn từ kỳ " + scenario.period_labels[scenario.first_below_threshold - 1] + ".";
    } else {
      when = "Không chạm ngưỡng nguy hiểm trong 12 kỳ tới.";
    }
    var isBaseline = scenario.key === "none";
    return '<div class="bar-item"' + (isBaseline ? ' style="opacity:0.75"' : "") + ">" +
      '<div class="bar-top"><span>' + App.esc(scenario.label) + (isBaseline ? " (để so sánh)" : "") + "</span>" +
      '<span class="chip ' + App.LIGHT_CLASS[scenario.traffic_light] + '">' + App.LIGHT_LABELS[scenario.traffic_light] + "</span></div>" +
      '<p class="tiny muted">' + App.esc(when) + "</p>" +
      '<p class="tiny faint num">Đáy: ' + App.formatDong(scenario.lowest_balance) + "</p>" +
      "</div>";
  }).join("");

  return '<div class="stack">' +
    '<dl class="stack-tight">' +
      '<div class="kv"><dt>Tổng chi phí sở hữu</dt><dd>' + App.formatDong(result.total_cost) + "</dd></div>" +
      '<div class="kv"><dt>Số dư hiện tại</dt><dd>' + App.formatDong(result.starting_balance) + "</dd></div>" +
    "</dl>" +
    App.lineChart(result.labels, result.baseline_series) +
    '<p class="tiny faint">Đường trên là quỹ đạo nếu KHÔNG mua. Bảng dưới so từng phương án.</p>' +
    rows +
    '<button type="button" class="secondary small" id="ai-simulation">Hỏi AI nên chọn phương án nào</button>' +
    '<div class="ai-panel hidden" id="ai-sim-panel"></div>' +
    "</div>";
};

// =============================================================== cài đặt

App.renderSettings = function (data) {
  var accountRows = (data ? data.accounts : []).map(function (account) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">' + App.esc(account.name) + "</span>" +
      '<span class="row-meta">' + App.esc(App.ACCOUNT_TYPES[account.type] || account.type) + "</span></div>" +
      '<div class="row-end"><span class="row-amount">' + App.formatDong(account.balance) + "</span>" +
      '<span class="row-actions"><button type="button" class="link" data-edit-account="' + App.esc(account.id) + '">Sửa</button></span>' +
      "</div></div>";
  }).join("");

  var ruleRows = (data ? data.rules : []).map(function (rule) {
    return '<div class="row">' +
      '<div class="row-main"><span class="row-title">“' + App.esc(rule.pattern) + "”</span>" +
      '<span class="row-meta">→ ' + App.esc(rule.category_name) + " · đã khớp " + rule.hit_count + " lần</span></div>" +
      '<div class="row-end"><span class="row-actions">' +
      '<button type="button" class="link link-danger" data-delete-rule="' + App.esc(rule.id) + '">Xóa</button>' +
      "</span></div></div>";
  }).join("");

  var categoryCount = data ? data.categories.length : 0;

  return '<section class="card">' +
      '<div class="card-head"><h2>Kết nối</h2>' +
      '<button type="button" class="link" id="show-connection">Đổi</button></div>' +
      '<p class="small muted">Đang dùng Google Sheet qua Apps Script. Dữ liệu nằm trong tài khoản Google của bạn, không đi qua máy chủ nào khác.</p>' +
      '<p class="tiny faint" id="connection-url"></p>' +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>Tình trạng bảng tính</h2>' +
      '<span class="tiny faint num" id="code-version"></span></div>' +
      '<p class="small muted">Bảng tính tự dựng khi mở lần đầu. Nếu có gì bất thường, bấm kiểm tra để biết chính xác thiếu chỗ nào.</p>' +
      '<div class="button-row">' +
        '<button type="button" class="secondary" id="run-health-check">Kiểm tra thiết lập</button>' +
        '<button type="button" class="secondary" id="run-setup-seed">Dựng lại tab còn thiếu</button>' +
      "</div>" +
      '<div id="setup-message"></div>' +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>Tài khoản</h2><span class="small muted">' + (data ? data.accounts.length : 0) + "</span></div>" +
      '<div class="rows">' + (accountRows || App.emptyState("Chưa có tài khoản nào.")) + "</div>" +
      '<form id="account-form">' +
        '<label class="field"><span class="field-label">Tên tài khoản mới</span>' +
        '<input type="text" name="name" placeholder="VD: MB Thanh toán" required></label>' +
        '<label class="field"><span class="field-label">Loại</span><select name="type">' +
          Object.keys(App.ACCOUNT_TYPES).map(function (key) {
            return '<option value="' + key + '">' + App.esc(App.ACCOUNT_TYPES[key]) + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field"><span class="field-label">Số dư ban đầu</span>' +
        '<input type="text" inputmode="numeric" name="balance" placeholder="0"></label>' +
        '<button type="submit" class="secondary">Thêm tài khoản</button>' +
        '<div id="account-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>Danh mục</h2><span class="small muted">' + categoryCount + "</span></div>" +
      '<form id="category-form">' +
        '<label class="field"><span class="field-label">Tên danh mục mới</span>' +
        '<input type="text" name="name" placeholder="VD: Ăn uống" required></label>' +
        '<label class="field"><span class="field-label">Loại</span><select name="kind">' +
          '<option value="expense">Chi tiêu</option><option value="income">Thu nhập</option>' +
          '<option value="transfer">Chuyển khoản nội bộ</option>' +
        "</select></label>" +
        '<label class="field"><span class="field-label">Thiết yếu hay tùy chọn</span><select name="necessity">' +
          '<option value="">Chưa xác định</option><option value="essential">Thiết yếu</option>' +
          '<option value="optional">Tùy chọn</option>' +
        "</select></label>" +
        '<label class="field"><span class="field-label">Cố định hay thay đổi</span><select name="stability">' +
          '<option value="">Chưa xác định</option><option value="fixed">Cố định</option>' +
          '<option value="variable">Thay đổi</option>' +
        "</select></label>" +
        '<p class="tiny muted">Hai lựa chọn trên nuôi các chỉ số rủi ro và gợi ý ngân sách — đáng điền cho danh mục chi tiêu.</p>' +
        '<button type="submit" class="secondary">Thêm danh mục</button>' +
        '<div id="category-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card">' +
      '<div class="card-head"><h2>Tự động phân loại</h2></div>' +
      '<p class="small muted">Khi mô tả chứa từ khóa, giao dịch bỏ trống danh mục sẽ tự được xếp vào danh mục tương ứng.</p>' +
      '<div class="rows">' + (ruleRows || App.emptyState("Chưa có luật nào.")) + "</div>" +
      '<form id="rule-form">' +
        '<label class="field"><span class="field-label">Từ khóa trong mô tả</span>' +
        '<input type="text" name="pattern" placeholder="VD: highlands" required></label>' +
        '<label class="field"><span class="field-label">Xếp vào danh mục</span><select name="category_id">' +
          (data ? App.categoryOptions(data.categories, "expense", null, false) : "") + "</select></label>" +
        '<button type="submit" class="secondary">Thêm luật</button>' +
        '<div id="rule-message"></div>' +
      "</form>" +
    "</section>" +

    '<section class="card"><h2>Dữ liệu của bạn</h2>' +
      '<p class="small muted">Tải toàn bộ giao dịch về máy dưới dạng CSV, mở được bằng Excel hay Google Sheets.</p>' +
      '<button type="button" class="secondary" id="export-csv">Tải CSV</button>' +
      '<button type="button" class="secondary" id="reset-connection">Xóa kết nối trên máy này</button>' +
    "</section>";
};
