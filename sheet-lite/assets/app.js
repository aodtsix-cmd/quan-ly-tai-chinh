/* =========================================================================
   app.js - state, tab routing, and every interaction.
   Rendering lives in views.js; this file decides what to render and what to
   send to Apps Script. Clicks are handled by one delegated listener, so any
   view can be re-rendered wholesale without rebinding anything.
   ========================================================================= */

var App = window.App;

App.state = {
  data: null,
  tab: "home",
  planSection: null, // null = show the hub; a key = show that section
  txFilter: "all",
  txQuery: "",
  txLimit: 40,
  txCategory: "",
  txAccount: "",
  txSort: "desc", // "desc" = server order (newest first); "asc" reverses it
  txOpenId: null, // which ledger row's inline detail is expanded
  goalDetailId: null, // which goal's detail view is open (null = the Hũ list)
  notificationsOpen: false, // Nhà's bell icon opens this in place of the dashboard
  notificationFilter: "all",
  readNotifications: {}, // session-only "read" flags, keyed by notification id - never persisted
  simSelectedScenario: "now", // which Mô phỏng scenario card is highlighted on the chart
  periodId: null,
  loading: false,
  // Add-form category picker: which id is chosen, and which parent's children
  // the grid is currently showing. Both live here rather than in the DOM so a
  // refresh of the <select> options can't lose the user's choice.
  categoryId: "",
  categoryParent: "",
};

// -------------------------------------------------------- simulation maths

App.INSTALLMENT_OPTIONS = [3, 6, 12];
App.DELAY_OPTIONS = [3, 6];
App.SIM_PERIODS = 12;

App.shiftPeriodId = function (periodId, months) {
  var parts = String(periodId).split("-");
  var index = (Number(parts[0]) * 12 + (Number(parts[1]) - 1)) + months;
  var year = Math.floor(index / 12);
  var month = (index % 12) + 1;
  return year + "-" + (month < 10 ? "0" + month : month);
};

// Every scenario shares the same total cost - only the TIMING of the outflow
// differs. No financing or interest is modelled: this app has no basis to
// assume an interest rate, and inventing one would be a fabricated number.
App.computeScenarios = function (data, itemAmount, maintenance) {
  var recent = (data.metrics.savings_trend.periods || []).slice(-3);
  var avgIncome = 0, avgExpense = 0;
  if (recent.length > 0) {
    recent.forEach(function (p) { avgIncome += p.income; avgExpense += p.expense; });
    avgIncome /= recent.length;
    avgExpense /= recent.length;
  }

  var start = data.money.liquid_balance;
  // Reuses the SAME "one period of essential spend" threshold the liquidity
  // warning already uses, rather than inventing a second one.
  var threshold = data.money.essential_expense_per_period;

  // Over a full 12 periods every scenario spends the same total, so their
  // LOWEST balances converge and comparing those alone tells you nothing.
  // What actually separates the options is WHEN the balance first breaks -
  // that's what gets surfaced.
  function project(extraFor) {
    var balance = start, series = [], lowest = Infinity;
    var firstNegative = null, firstBelowThreshold = null;
    for (var i = 0; i < App.SIM_PERIODS; i++) {
      balance += avgIncome - avgExpense - extraFor(i);
      series.push(Math.round(balance));
      if (balance < lowest) lowest = balance;
      if (firstNegative === null && balance < 0) firstNegative = i + 1;
      if (firstBelowThreshold === null && threshold && balance < threshold) firstBelowThreshold = i + 1;
    }
    return {
      series: series,
      lowest: Math.round(lowest),
      first_negative: firstNegative,
      first_below_threshold: firstBelowThreshold,
    };
  }

  function light(series) {
    if (series.some(function (v) { return v < 0; })) return "red";
    if (threshold && series.some(function (v) { return v < threshold; })) return "yellow";
    return "green";
  }

  var baseline = project(function () { return 0; });

  // The no-purchase row is listed alongside the others on purpose: if the
  // trajectory is already breaking without the purchase, "red" on every
  // option means something quite different from the purchase causing it.
  var scenarios = [
    { key: "none", label: App.t("plan.simulate.scenario.none"), projection: baseline },
    { key: "now", label: App.t("plan.simulate.scenario.now"), projection: project(function (i) { return (i === 0 ? itemAmount : 0) + maintenance; }) },
  ];

  App.INSTALLMENT_OPTIONS.forEach(function (n) {
    scenarios.push({
      key: "installment_" + n,
      label: App.t("plan.simulate.scenario.installment", { n: n }),
      projection: project(function (i) { return (i < n ? itemAmount / n : 0) + maintenance; }),
    });
  });

  App.DELAY_OPTIONS.forEach(function (n) {
    scenarios.push({
      key: "delay_" + n,
      label: App.t("plan.simulate.scenario.delay", { n: n }),
      projection: project(function (i) { return (i === n ? itemAmount : 0) + (i >= n ? maintenance : 0); }),
    });
  });

  var labels = [];
  for (var i = 0; i < App.SIM_PERIODS; i++) {
    labels.push(App.shiftPeriodId(data.period.current_id, i + 1));
  }

  return {
    total_cost: itemAmount + maintenance * App.SIM_PERIODS,
    starting_balance: start,
    labels: labels,
    baseline_series: baseline.series,
    scenarios: scenarios.map(function (s) {
      return {
        key: s.key,
        label: s.label,
        lowest_balance: s.projection.lowest,
        first_negative: s.projection.first_negative,
        first_below_threshold: s.projection.first_below_threshold,
        period_labels: labels,
        series: s.projection.series,
        traffic_light: light(s.projection.series),
      };
    }),
  };
};

// ------------------------------------------------------------------ notices

App.notice = function (selector, text, kind) {
  var node = App.$(selector);
  if (!node) return;
  if (!text) { node.innerHTML = ""; return; }
  node.innerHTML = '<p class="notice notice-' + kind + '">' + App.esc(text) + "</p>";
};

// -------------------------------------------------------------- data loading

// An Apps Script round trip takes a second or three, and a dead deployment
// URL can hang indefinitely - so something must be on screen from the first
// paint. A blank page reads as "the app is broken" long before it is.
// Measured against a real deployment: the FIRST call after a deploy took 97
// seconds while Apps Script cold-started, and every call after it was under a
// second. A silent wait that long is indistinguishable from a hang, so the
// message escalates instead of sitting still.
// Keys, not literal text: App.showLoading() calls App.t() on these at paint
// time, so the escalating hints come out in whichever language is active.
App.LOADING_HINTS = [
  [0, "loading.hint0"],
  [6000, "loading.hint1"],
  [45000, "loading.hint2"],
];

App.clearLoadingTimers = function () {
  (App.loadingTimers || []).forEach(window.clearTimeout);
  App.loadingTimers = [];
};

App.showLoading = function () {
  App.clearLoadingTimers();
  function paint(hintKey) {
    App.setHtml("#view-home",
      '<section class="card">' +
        '<span class="eyebrow">' + App.esc(App.t("loading.eyebrow")) + "</span>" +
        "<h1>" + App.esc(App.t("loading.title")) + "</h1>" +
        '<p class="small muted">' + App.esc(App.t(hintKey)) + "</p>" +
      "</section>");
  }
  paint(App.LOADING_HINTS[0][1]);
  App.LOADING_HINTS.slice(1).forEach(function (step) {
    App.loadingTimers.push(window.setTimeout(function () {
      // Only keep escalating while the request really is still in flight.
      if (App.state.loading) paint(step[1]);
    }, step[0]));
  });
};

// Never leave the screen blank. Every failure - no network, wrong token, an
// out-of-date Code.gs, or a render that threw - lands here with a plain
// explanation and something to press.
App.showFatal = function (title, messageHtml) {
  App.state.data = null;
  App.state.fatalHtml =
    '<section class="card">' +
      '<span class="eyebrow">' + App.esc(App.t("fatal.eyebrow")) + "</span>" +
      "<h1>" + App.esc(title) + "</h1>" +
      '<div class="small muted stack-tight">' + messageHtml + "</div>" +
      '<div class="button-row">' +
        '<button type="button" id="retry-load">' + App.esc(App.t("fatal.retry")) + "</button>" +
        '<button type="button" class="secondary" id="show-connection">' + App.esc(App.t("fatal.change_connection")) + "</button>" +
      "</div>" +
    "</section>";
  App.switchTab("home");
};

// opts.data lets a caller that already has a fresh bootstrap payload in hand
// (v3.7+ Code.gs echoes one back in every write response, see App.apiPost)
// skip the network round trip entirely instead of asking for the same thing
// twice. Falls back to a real fetch whenever it isn't supplied - a v3.6
// backend, or the initial page load, which has nothing to echo yet.
App.load = function (options) {
  var opts = options || {};
  App.state.loading = true;
  var params = App.state.periodId ? { period_id: App.state.periodId } : {};

  return (opts.data ? Promise.resolve(opts.data) : App.apiGet("bootstrap", params))
    .then(function (data) {
      App.state.loading = false;

      // The connection can succeed while pointing at an OLDER Code.gs whose
      // response has none of the fields this frontend reads - which used to
      // throw deep inside rendering and leave a blank page with no clue why.
      if (!data || !data.period || !data.money || !data.health || !data.metrics) {
        // Ask the deployment what it actually is, so the message can name the
        // real gap instead of guessing. This is the whole reason the version
        // action skips the token check.
        App.fetchVersion().then(function (deployed) {
          App.showFatal(App.t("fatal.old_version_title"),
            App.t("fatal.old_version.p1") +
            App.t("fatal.old_version.p2", {
              deployed: deployed ? "v" + App.esc(deployed) : App.t("fatal.old_version.deployed_unknown"),
              expected: App.EXPECTED_VERSION,
            }) +
            App.t("fatal.old_version.p3") +
            App.t("fatal.old_version.steps") +
            App.t("fatal.old_version.p5"));
        });
        return null;
      }

      App.state.fatalHtml = null;
      App.state.data = data;
      App.renderCurrentTab();
      App.updateTopbar();
      if (!opts.quiet && data.recurring_generated > 0) {
        window.setTimeout(function () {
          App.notice("#add-message", App.t("fatal.recurring_generated", { n: data.recurring_generated }), "info");
        }, 0);
      }
      return data;
    })
    .catch(function (err) {
      App.state.loading = false;
      App.showFatal(App.t("fatal.load_failed_title"), "<p>" + App.esc(App.errorText(err)) + "</p>");
    });
};

// ------------------------------------------------------------------ topbar

App.updateTopbar = function () {
  var data = App.state.data;
  if (!data) return;
  // Two stacked lines rather than one long run of text: at 375px the single
  // line wrapped mid-phrase and pushed the topbar to double height.
  App.setHtml(
    "#period-chip",
    '<b class="num">' + App.esc(App.formatPeriodRange(data.period)) + "</b>" +
    '<i class="tiny faint">' + App.esc(App.t("metric.forecast.note", { days: data.period.days_remaining })) + "</i>"
  );
};

// -------------------------------------------------------------------- tabs

App.closeDialog = function () {
  var dialog = App.$("#tx-dialog");
  if (dialog && dialog.open) dialog.close();
};

// A modal has to be dismissable three ways or it feels like a trap: the X,
// clicking the dim area outside it, and Escape. <dialog> gives Escape for
// free; the other two are wired here, once, for every dialog the app opens.
(function wireDialogDismissal() {
  var dialog = document.getElementById("tx-dialog");
  if (!dialog) return;
  dialog.addEventListener("click", function (event) {
    // A click landing on the <dialog> itself rather than its content is a
    // click on the backdrop - the content sits in an inner wrapper.
    if (event.target === dialog) App.closeDialog();
  });
})();

App.TABS = ["home", "add", "list", "plan", "settings"];

App.switchTab = function (tab, options) {
  var keepScroll = options && options.keepScroll;
  App.state.tab = tab;
  App.TABS.forEach(function (name) {
    App.show("#view-" + name, name === tab);
    // Scoped to .tabbar deliberately: Home reuses data-tab="list"/"add" for its
    // own "Xem tất cả" link and "+" quick action as plain navigation shortcuts,
    // and those elements stay in the DOM (just hidden) once Home isn't the
    // active tab. An unscoped selector grabbed whichever matched first - the
    // Home shortcut, not the real tab bar button - so the actual "Sổ"/"Nhập"
    // tab never received aria-selected="true" and never lit up.
    var button = App.$('.tabbar [data-tab="' + name + '"]');
    if (button) button.setAttribute("aria-selected", String(name === tab));
  });
  // Only jump to the top when the tab actually changes. Re-rendering in place
  // - switching a Kế hoạch sub-section, saving a row - must leave the reader
  // where they were.
  if (!keepScroll) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  App.renderCurrentTab();
};

App.renderCurrentTab = function () {
  var data = App.state.data;

  // No data yet: show whatever the last failure said, on whichever tab the
  // user is looking at, rather than an empty screen.
  if (!data) {
    if (App.state.fatalHtml) App.setHtml("#view-" + App.state.tab, App.state.fatalHtml);
    return;
  }

  // A render that throws must not blank the page. This is the net that a
  // mismatched backend payload used to fall straight through.
  try {
    if (App.state.tab === "home") {
      App.setHtml("#view-home", App.renderDashboard(data));
      App.animateBalance();
      App.loadDailySummary();
    }
    else if (App.state.tab === "add") App.refreshAddForm();
    else if (App.state.tab === "list") App.renderList();
    else if (App.state.tab === "plan") App.renderPlan();
    else if (App.state.tab === "settings") App.renderSettingsTab();
  } catch (err) {
    App.showFatal(App.t("fatal.render_error_title"),
      "<p>" + App.esc(String((err && err.message) || err)) + "</p>" + App.t("fatal.render_error_hint"));
  }
};

// --------------------------------------------------------------- dashboard

// Runs once per real load, not on every re-render: a number that re-animates
// every time a background refresh finishes reads as a glitch, not a flourish.
App.balanceAnimatedFor = null;

App.animateBalance = function () {
  var node = App.$(".neon-networth-amount");
  var data = App.state.data;
  if (!node || !data || App.netWorthHidden()) return;
  var value = data.money.net_worth;
  if (App.balanceAnimatedFor === value) return;
  App.balanceAnimatedFor = value;
  App.countUp(node, value, function (current) {
    return App.formatVnd(current) + "đ";
  });
};

App.aiSummaryLoadedFor = null;

App.loadDailySummary = function () {
  var panel = App.$("#ai-daily");
  if (!panel) return;
  var today = App.today();

  // One call per day per page session: the summary only changes daily, and
  // Apps Script calls are slow enough that re-fetching on every tab switch
  // would be felt.
  if (App.aiSummaryCache && App.aiSummaryLoadedFor === today) {
    panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("home.ai_daily.eyebrow")) + "</span><p>" + App.esc(App.aiSummaryCache) + "</p>";
    panel.classList.remove("hidden");
    return;
  }
  if (App.aiSummaryLoadedFor === today) return; // tried already, unavailable

  panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("home.ai_daily.eyebrow")) + '</span><p class="muted">' + App.esc(App.t("home.ai_daily.loading")) + "</p>";
  panel.classList.remove("hidden");

  App.apiGet("get_ai_summary")
    .then(function (result) {
      App.aiSummaryLoadedFor = today;
      if (!result.available) {
        // "no_data" (empty ledger) is the one refusal worth naming instead of
        // just disappearing - it's the AI declining to guess, not a generic
        // outage, and the handoff's own AI-states gallery treats that
        // distinction as worth surfacing. Every other reason (no_key, quota,
        // network) still degrades silently, unchanged - those are already
        // covered by other UI (Settings' health check names a missing key).
        if (result.reason === "no_data") {
          panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("home.ai_daily.eyebrow")) + "</span>" +
            '<p class="muted">' + App.esc(App.t("home.ai_daily.no_data")) + "</p>";
          panel.classList.remove("hidden");
          return;
        }
        panel.classList.add("hidden");
        return;
      }
      App.aiSummaryCache = result.summary;
      panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("home.ai_daily.eyebrow")) + "</span><p>" + App.esc(result.summary) + "</p>";
    })
    .catch(function () {
      App.aiSummaryLoadedFor = today;
      panel.classList.add("hidden");
    });
};

// ------------------------------------------------------------- add-transaction

App.currentDirection = function () {
  var checked = App.$('input[name="direction"]:checked');
  return checked ? checked.value : "out";
};

// One accent per transaction type, driving the hero card, the type-coloured
// input text and the source chip row - kept as data rather than a class per
// type so a future type needs no new CSS rule, only a new entry here.
App.TYPE_ACCENT = {
  out: { accent: "var(--neon-red)", tint: "rgba(255,107,122,0.1)", border: "rgba(255,107,122,0.3)" },
  in: { accent: "var(--neon-green)", tint: "rgba(63,245,165,0.1)", border: "rgba(63,245,165,0.3)" },
  transfer: { accent: "var(--neon-purple)", tint: "rgba(177,140,255,0.1)", border: "rgba(177,140,255,0.3)" },
};

App.refreshAddForm = function () {
  var data = App.state.data;
  if (!data) return;
  var direction = App.currentDirection();
  var accent = App.TYPE_ACCENT[direction];

  var accountInput = App.$("#tx-account");
  var toAccountInput = App.$("#tx-to-account");
  var keepAccount = accountInput.value, keepTo = toAccountInput.value;

  function resolveSelection(kept, list) {
    return list.some(function (a) { return String(a.id) === String(kept); }) ? kept : (list[0] ? list[0].id : "");
  }
  var accountId = resolveSelection(keepAccount, data.accounts);
  var toAccountId = resolveSelection(keepTo, data.accounts);

  accountInput.value = accountId;
  App.setHtml("#tx-account-chips", App.accountChips(data.accounts, accountId, "data-pick-account", false));
  toAccountInput.value = toAccountId;
  App.setHtml("#tx-to-account-chips", App.accountChips(data.accounts, toAccountId, "data-pick-to-account", true));

  App.renderCategoryGrid();

  App.show("#tx-to-wrap", direction === "transfer");
  App.show("#tx-category-wrap", direction !== "transfer");
  App.$("#tx-account-label").textContent = direction === "out" ? App.t("add.source_out")
    : direction === "in" ? App.t("add.source_in") : App.t("add.source_transfer");

  // The type's accent/tint live as custom properties on the FORM, not the
  // hero card alone - custom properties inherit down the tree but not across
  // siblings, and the category grid's selected-tile colour and the account
  // chips' selected-chip colour both need to match the hero's colour too.
  // Setting them only on #tx-hero left every other selected control reading
  // an unset var() and falling back to no colour at all.
  var form = App.$("#tx-form");
  form.style.setProperty("--accent", accent.accent);
  form.style.setProperty("--tint", accent.tint);
  form.style.setProperty("--tint-border", accent.border);
  App.$("#tx-hero-label").textContent = App.t(
    direction === "out" ? "add.hero_label_out" : direction === "in" ? "add.hero_label_in" : "add.hero_label_transfer"
  );
  App.$("#tx-hero-hint").innerHTML = App.t("add.hero_hint", { a: "500k", b: "1tr", c: "2tr5" });

  var dateInput = App.$("#tx-date");
  if (!dateInput.value) dateInput.value = App.today();
  App.updateDateDisplay();

  App.updateAmountHint();
  var recentRows = data.transactions.slice(0, 5).map(App.neonRecentRow).join("");
  App.setHtml("#add-recent", recentRows || App.emptyState(App.t("ledger.no_match")));
};

// Only the grid and its chip are touched here - never the amount, the note or
// the date. The rule that the add form is not re-rendered underneath the user
// still holds; this is one control refreshing itself.
App.renderCategoryGrid = function () {
  var data = App.state.data;
  var grid = App.$("#tx-category-grid");
  if (!data || !grid) return;
  var kind = App.currentDirection() === "in" ? "income" : "expense";

  grid.innerHTML = App.categoryGrid(data.categories, kind, App.state.categoryId, App.state.categoryParent);
  App.$("#tx-category").value = App.state.categoryId || "";

  var label = App.categoryLabel(data.categories, App.state.categoryId);
  App.setHtml("#tx-category-picked", label
    ? App.icon(App.categoryIconName(label)) + "<span>" + App.esc(label) + "</span>"
    : '<span class="faint tiny">' + App.esc(App.t("add.category_empty_hint")) + "</span>");
};

App.pickCategory = function (id) {
  // Tapping the lit tile again clears it: leaving the category blank is a
  // real choice - it hands the row to the auto-categorisation rules.
  App.state.categoryId = String(App.state.categoryId) === String(id) ? "" : String(id);
  App.renderCategoryGrid();
};

App.pickAccount = function (id) {
  App.$("#tx-account").value = id;
  App.$$("#tx-account-chips .neon-chip").forEach(function (chip) {
    chip.setAttribute("aria-pressed", String(chip.getAttribute("data-pick-account") === String(id)));
  });
};

App.pickToAccount = function (id) {
  App.$("#tx-to-account").value = id;
  App.$$("#tx-to-account-chips .neon-chip").forEach(function (chip) {
    chip.setAttribute("aria-pressed", String(chip.getAttribute("data-pick-to-account") === String(id)));
  });
};

// The date field is a real, visible native input now (it displays its own
// value) - all this does is light up whichever of "Hôm qua"/"Hôm nay"
// matches the field's current value, or neither once a different date has
// been typed or picked. Previously "Hôm nay" was hardcoded green regardless
// of the actual selected date, which read as if today stayed selected even
// after choosing something else.
App.updateDateDisplay = function () {
  var iso = App.$("#tx-date").value;
  var todayBtn = App.$("#tx-today-btn");
  var yesterdayBtn = App.$("#tx-yesterday-btn");
  if (todayBtn) todayBtn.setAttribute("aria-pressed", String(iso === App.today()));
  if (yesterdayBtn) yesterdayBtn.setAttribute("aria-pressed", String(iso === App.yesterday()));
};

App.setTodayDate = function () {
  App.$("#tx-date").value = App.today();
  App.updateDateDisplay();
};

App.setYesterdayDate = function () {
  App.$("#tx-date").value = App.yesterday();
  App.updateDateDisplay();
};

App.updateAmountHint = function () {
  var input = App.$("#tx-amount");
  var hint = App.$("#tx-amount-hint");
  var parsed = App.tryParseAmount(input.value);
  if (parsed === null) {
    hint.textContent = input.value.trim() ? App.t("add.amount_hint_invalid") : "";
    hint.className = "neon-hero-echo " + (input.value.trim() ? "amount-out" : "");
  } else {
    hint.textContent = App.t("add.amount_hint_equals", { amount: App.formatDong(parsed) });
    hint.className = "neon-hero-echo muted";
  }
  App.updateNudge(parsed);
};

// A soft suggestion, not a blocking confirm() - per docs/UI-DESIGN-SPEC.md
// §4.3's own original wording ("hiện gợi ý mềm"). Recomputed on every
// keystroke and direction change; showing or hiding it never affects
// whether Lưu giao dịch actually saves.
App.updateNudge = function (parsed) {
  var show = App.currentDirection() === "out" && parsed !== null && parsed >= 1000000;
  App.show("#tx-nudge", show);
  if (show) App.setHtml("#tx-nudge-text", App.t("add.nudge_text"));
};

App.submitTransaction = function () {
  var data = App.state.data;
  var direction = App.currentDirection();
  var rawAmount = App.$("#tx-amount").value.trim();
  var description = App.$("#tx-description").value.trim();
  var occurredAt = App.$("#tx-date").value;
  var parsed = App.tryParseAmount(rawAmount);

  if (!rawAmount || parsed === null || parsed <= 0) {
    App.notice("#add-message", App.t("add.error_amount_required"), "error");
    return;
  }
  if (direction === "transfer" && App.$("#tx-account").value === App.$("#tx-to-account").value) {
    App.notice("#add-message", App.t("add.error_same_account"), "error");
    return;
  }

  var button = App.$("#tx-save");
  button.disabled = true;
  App.notice("#add-message", "", "info");

  // The RAW text goes to the server: Code.gs's parseAmountVnd_ is the single
  // source of truth for what actually gets saved. The client-side parse above
  // is only a preview and a sanity check.
  var request = direction === "transfer"
    ? App.apiPost("add_transfer", {
        from_account_id: App.$("#tx-account").value,
        to_account_id: App.$("#tx-to-account").value,
        amount: rawAmount, description: description, occurred_at: occurredAt,
      })
    : App.apiPost("add_transaction", {
        direction: direction,
        account_id: App.$("#tx-account").value,
        category_id: App.$("#tx-category").value,
        amount: rawAmount, description: description, occurred_at: occurredAt,
      });

  request
    .then(function (result) {
      // Re-enable and confirm the moment the WRITE lands - the bootstrap
      // reload that follows only refreshes numbers elsewhere on the page and
      // has no reason to keep the form locked while it's in flight.
      button.disabled = false;
      App.$("#tx-amount").value = "";
      App.$("#tx-description").value = "";
      App.updateAmountHint();
      var extra = result.auto_categorised ? App.t("add.saved_auto_categorised") : "";
      App.notice("#add-message", App.t("add.saved", { amount: App.formatDong(result.amount || parsed) }) + extra, "ok");
      App.load({ quiet: true, data: result.bootstrap });
    })
    .catch(function (err) {
      button.disabled = false;
      App.notice("#add-message", App.errorText(err), "error");
    });
};

// ------------------------------------------------------- import from image

// Apps Script has a payload ceiling and a phone camera shot can be several
// megabytes, so the image is downscaled in the browser before it is sent.
// 1280px on the long edge is far more than enough to read a receipt.
App.IMPORT_MAX_EDGE = 1280;

App.fileToScaledBase64 = function (file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error(App.t("import.file_unreadable"))); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error(App.t("import.file_not_image"))); };
      img.onload = function () {
        var scale = Math.min(1, App.IMPORT_MAX_EDGE / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
};

// Images are read ONE AT A TIME rather than in parallel: every write action
// behind this API takes a script lock anyway, Apps Script cold-starts badly
// under a burst, and a serial loop is what makes per-image progress and
// per-image failure reporting possible. Ten screenshots is an ordinary batch.
App.analyzeImages = function (files) {
  var list = Array.prototype.slice.call(files);
  App.importCandidates = [];
  var seenRefs = {};
  var failed = [];

  function paintProgress(index) {
    App.setHtml("#import-result", App.renderImportProgress(index, list.length, App.importCandidates.length));
  }

  function step(index) {
    if (index >= list.length) return finish();
    paintProgress(index);

    return App.fileToScaledBase64(list[index])
      .then(function (image) {
        return App.apiPost("analyze_image", { image_base64: image.base64, mime_type: image.mimeType });
      })
      .then(function (result) {
        if (!result.available) {
          failed.push({ name: list[index].name, reason: result.reason });
          return;
        }
        result.candidates.forEach(function (candidate) {
          // De-duplicate across images too: the same receipt screenshotted
          // twice, or a list view plus its detail view, is a real habit.
          if (seenRefs[candidate.external_ref]) return;
          seenRefs[candidate.external_ref] = true;
          App.importCandidates.push(candidate);
        });
      })
      .catch(function (err) {
        failed.push({ name: list[index].name, reason: App.errorText(err) });
      })
      .then(function () { return step(index + 1); });
  }

  function finish() {
    var noKey = failed.some(function (f) { return f.reason === "no_key"; });
    var notice = "";
    if (noKey) {
      notice = '<p class="notice notice-info">' + App.esc(App.t("import.no_key")) + "</p>";
    } else if (failed.length) {
      notice = '<p class="notice notice-info">' + App.esc(App.t("import.some_failed", {
        failed: failed.length, total: list.length, names: failed.map(function (f) { return f.name; }).join(", "),
      })) + "</p>";
    }
    App.setHtml("#import-result", notice +
      (App.importCandidates.length || !noKey
        ? App.renderImportCandidates(App.state.data, App.importCandidates)
        : ""));
  }

  step(0);
};

App.saveImport = function () {
  var rows = App.$$("#import-result [data-candidate]").filter(function (node) {
    return node.querySelector("[data-cand-use]").checked;
  }).map(function (node) {
    return {
      amount: node.querySelector("[data-cand-amount]").value.trim(),
      direction: node.querySelector("[data-cand-dir]:checked").value,
      note: node.querySelector("[data-cand-note]").value.trim(),
      account_id: node.querySelector("[data-cand-account]").value,
      category_id: node.querySelector("[data-cand-category]").value,
      external_ref: node.querySelector("[data-cand-ref]").value,
    };
  });

  if (rows.length === 0) {
    App.notice("#import-save-message", App.t("import.none_selected"), "info");
    return;
  }
  App.$("#save-import").disabled = true;
  App.notice("#import-save-message", App.t("common.saving"), "info");

  App.apiPost("import_transactions", { rows: rows })
    .then(function (result) {
      var parts = [App.t("import.saved_summary", { n: result.saved })];
      if (result.skipped_duplicate) parts.push(App.t("import.skipped_duplicate", { n: result.skipped_duplicate }));
      if (result.skipped_invalid) parts.push(App.t("import.skipped_invalid", { n: result.skipped_invalid }));
      App.setHtml("#import-result", '<p class="notice notice-ok">' + App.esc(parts.join(" ")) + "</p>");
      App.$("#import-file").value = "";
      return App.load({ quiet: true, data: result.bootstrap });
    })
    .catch(function (err) {
      App.notice("#import-save-message", App.errorText(err), "error");
      if (App.$("#save-import")) App.$("#save-import").disabled = false;
    });
};

// -------------------------------------------------------------------- list

App.filteredTransactions = function () {
  var data = App.state.data;
  var query = App.state.txQuery.trim().toLowerCase();
  var rows = data.transactions.filter(function (tx) {
    if (App.state.txFilter === "out" && (tx.direction !== "out" || tx.is_transfer)) return false;
    if (App.state.txFilter === "in" && (tx.direction !== "in" || tx.is_transfer)) return false;
    if (App.state.txFilter === "transfer" && !tx.is_transfer) return false;
    if (App.state.txCategory && String(tx.category_id) !== String(App.state.txCategory)) return false;
    if (App.state.txAccount && String(tx.account_id) !== String(App.state.txAccount)) return false;
    if (!query) return true;
    return [tx.description, tx.category_name, tx.account_name, tx.amount]
      .join(" ").toLowerCase().indexOf(query) !== -1;
  });
  // The server already sorts newest-first; "asc" just reverses that view,
  // no re-fetch needed.
  return App.state.txSort === "asc" ? rows.slice().reverse() : rows;
};

App.renderList = function () {
  App.setHtml("#view-list", App.renderLedger(App.state.data));
};

App.openEditDialog = function (id) {
  var data = App.state.data;
  var tx = data.transactions.filter(function (t) { return String(t.id) === String(id); })[0];
  if (!tx) return;

  var kind = tx.direction === "in" ? "income" : "expense";
  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>' + App.esc(App.t("dialog.edit_tx.title")) + '</h2>' +
    '<button type="button" class="icon-btn" data-close-dialog aria-label="' + App.esc(App.t("dialog.edit_tx.close_aria")) + '">\u2715</button></div>' +
    '<form id="edit-form">' +
      '<input type="hidden" name="id" value="' + App.esc(tx.id) + '">' +
      '<div class="segmented">' +
        '<input type="radio" id="edit-out" name="direction" value="out"' + (tx.direction === "out" ? " checked" : "") + '><label for="edit-out">' + App.esc(App.t("dialog.edit_tx.direction_out")) + '</label>' +
        '<input type="radio" id="edit-in" name="direction" value="in"' + (tx.direction === "in" ? " checked" : "") + '><label for="edit-in">' + App.esc(App.t("dialog.edit_tx.direction_in")) + '</label>' +
      "</div>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_tx.amount_label")) + '</span>' +
      '<input type="text" inputmode="numeric" name="amount" class="amount-input" value="' + App.esc(App.formatVnd(tx.amount)) + '"></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_tx.date_label")) + '</span>' +
      '<input type="date" name="occurred_at" value="' + App.esc(App.dateOnly(tx.occurred_at)) + '"></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_tx.account_label")) + '</span>' +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, tx.account_id, false) + "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_tx.category_label")) + '</span>' +
      '<select name="category_id">' + App.categoryOptions(data.categories, kind, tx.category_id) + "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_tx.description_label")) + '</span>' +
      '<input type="text" name="description" value="' + App.esc(tx.description || "") + '"></label>' +
      // Correcting a category is the moment the user has just told the app
      // what a description means - the cheapest possible time to offer to
      // remember it. Same "learn from correction" loop as the Flask app's
      // edit page. Only offered when the category actually changed, so it
      // never nags on an unrelated edit.
      (tx.description
        ? '<div class="notice notice-info hidden" id="learn-rule-block">' +
          '<label class="inline"><input type="checkbox" name="learn_rule" value="1" style="width:auto;min-height:0">' +
          " <span>" + App.esc(App.t("dialog.edit_tx.learn_rule_label")) + "</span></label>" +
          '<input type="text" name="learn_pattern" value="' + App.esc(tx.description) +
          '" style="margin-top:0.5rem" aria-label="' + App.esc(App.t("dialog.edit_tx.learn_rule_pattern_aria")) + '">' +
          '<p class="tiny muted">' + App.esc(App.t("dialog.edit_tx.learn_rule_hint")) + "</p></div>"
        : "") +
      "<button type=\"submit\">" + App.esc(App.t("dialog.edit_tx.submit")) + "</button>" +
      '<div id="edit-message"></div>' +
    "</form>"
  );

  // Reveal the learn-a-rule offer only once the category is actually changed.
  var categorySelect = App.$('#edit-form [name="category_id"]');
  var learnBlock = App.$("#learn-rule-block");
  if (learnBlock && categorySelect) {
    categorySelect.addEventListener("change", function () {
      var changed = String(categorySelect.value) !== String(tx.category_id || "") && categorySelect.value !== "";
      learnBlock.classList.toggle("hidden", !changed);
    });
  }
  App.$("#tx-dialog").showModal();
};

// -------------------------------------------------------------------- plan

// Just the routing keys - labels come from App.label("plan_section", key) at
// render time, so a language switch relabels the chips without touching this.
App.PLAN_SECTIONS = [
  ["analytics"], ["budget"], ["goals"], ["events"], ["income"], ["recurring"], ["forecast"], ["simulate"],
];

// Sections whose render function already returns a full Dark Neon screen
// (own header, own dark surface) - the shared subnav/planHeader chrome stays
// on the original light system either way (same "light system chrome over
// dark content" pattern already proven by the topbar/tabbar on Nhà/Nhập),
// but planHeader's own card is skipped for these since each one draws its
// own header instead of using the generic icon+title+desc card.
App.PLAN_NEON_SECTIONS = { analytics: true, budget: true, forecast: true, goals: true, simulate: true };

App.renderPlan = function () {
  var data = App.state.data;

  // No section chosen yet: show the hub instead of silently landing on
  // whichever section happens to be first.
  if (!App.state.planSection) {
    App.setHtml("#view-plan", App.renderPlanHub());
    return;
  }

  var nav = '<div class="subnav">' +
    '<button type="button" data-plan-section="" aria-pressed="false" aria-label="' + App.esc(App.t("common.all_sections_aria")) + '">☰</button>' +
    App.PLAN_SECTIONS.map(function (pair) {
      return '<button type="button" data-plan-section="' + pair[0] + '" aria-pressed="' +
        (App.state.planSection === pair[0]) + '">' + App.esc(App.label("plan_section", pair[0])) + "</button>";
    }).join("") + "</div>";

  var body;
  if (App.state.planSection === "analytics") body = App.renderAnalyticsPlan(data);
  else if (App.state.planSection === "budget") body = App.renderBudgetPlan(data);
  else if (App.state.planSection === "goals") body = App.renderGoalsPlan(data);
  else if (App.state.planSection === "events") body = App.renderEventsPlan(data);
  else if (App.state.planSection === "income") body = App.renderIncomePlan(data);
  else if (App.state.planSection === "recurring") body = App.renderRecurringPlan(data);
  else if (App.state.planSection === "forecast") body = App.renderForecastPlan();
  else body = App.renderSimulationPlan();

  var isNeon = !!App.PLAN_NEON_SECTIONS[App.state.planSection];
  var header = isNeon ? "" : App.planHeader(App.state.planSection);
  var wrapped = isNeon ? '<div class="neon-plan-section">' + body + "</div>" : body;
  App.setHtml("#view-plan", nav + header + wrapped);
  if (App.state.planSection === "events") App.resetEventItems();
};

// The new-event form starts with a few blank rows; picking a template swaps in
// its item NAMES (never prices) and leaves every amount for the user to fill.
App.resetEventItems = function (templateIndex) {
  var host = App.$("#event-items");
  if (!host) return;
  var html = "";
  if (templateIndex !== undefined && templateIndex !== "") {
    var template = App.state.data.event_templates[Number(templateIndex)];
    if (template) template.items.forEach(function (name) { html += App.eventItemRow(name, true); });
  }
  var blanks = templateIndex ? 1 : 3;
  for (var i = 0; i < blanks; i++) html += App.eventItemRow("", false);
  host.innerHTML = html;
};

App.collectEventItems = function () {
  return App.$$("#event-items > div").map(function (row) {
    return {
      name: row.querySelector("[data-item-name]").value.trim(),
      expected_amount: row.querySelector("[data-item-amount]").value.trim(),
    };
  }).filter(function (item) { return item.name; });
};

App.saveBudgets = function () {
  var inputs = App.$$("[data-budget-input]");
  var jobs = [];
  var invalid = [];

  inputs.forEach(function (input) {
    var raw = input.value.trim();
    if (!raw) return; // blank means "no budget for this category", not an error
    var parsed = App.tryParseAmount(raw);
    if (parsed === null || parsed <= 0) {
      invalid.push(input.previousElementSibling ? input.id : input.id);
      return;
    }
    jobs.push({ category_id: input.getAttribute("data-budget-input"), amount: raw });
  });

  if (invalid.length > 0) {
    App.notice("#budget-message", App.t("plan.budget.invalid_fields", { n: invalid.length }), "error");
    return;
  }
  if (jobs.length === 0) {
    App.notice("#budget-message", App.t("plan.budget.none_entered"), "info");
    return;
  }

  var button = App.$("#save-budgets");
  button.disabled = true;
  App.notice("#budget-message", App.t("plan.budget.saving_n", { n: jobs.length }), "info");

  // Sheets writes are serialised behind the script lock anyway, so these go
  // one at a time rather than racing a burst of parallel requests. Only the
  // LAST job's echoed bootstrap is kept - the ones in between are already
  // stale by the time the next write lands, so there's no point reloading
  // from any of them.
  var chain = Promise.resolve();
  var lastResult = null;
  jobs.forEach(function (job) {
    chain = chain.then(function () {
      return App.apiPost("set_period_budget", {
        category_id: job.category_id,
        period_id: App.state.data.period.id,
        amount: job.amount,
      }).then(function (result) { lastResult = result; });
    });
  });

  chain
    .then(function () {
      App.notice("#budget-message", App.t("plan.budget.saved"), "ok");
      App.load({ quiet: true, data: lastResult && lastResult.bootstrap });
    })
    .catch(function (err) { App.notice("#budget-message", App.errorText(err), "error"); })
    .finally(function () { if (App.$("#save-budgets")) App.$("#save-budgets").disabled = false; });
};

App.runForecast = function () {
  var includeGoals = App.$("#forecast-goals").checked;
  var useReliable = App.$("#forecast-reliable").checked;
  App.setHtml("#forecast-result", '<p class="small muted">' + App.esc(App.t("plan.forecast.computing")) + "</p>");

  App.apiGet("get_forecast", {
    periods_ahead: 6,
    include_goals: includeGoals ? "1" : "0",
    income_basis_reliable: useReliable ? "1" : "0",
  })
    .then(function (result) { App.setHtml("#forecast-result", App.renderForecastResult(result)); })
    .catch(function (err) {
      App.setHtml("#forecast-result", '<p class="notice notice-error">' + App.esc(App.errorText(err)) + "</p>");
    });
};

App.runSimulation = function () {
  var amount = App.tryParseAmount(App.$("#sim-amount").value);
  var maintenance = App.tryParseAmount(App.$("#sim-maintenance").value) || 0;
  if (!amount || amount <= 0) {
    App.setHtml("#simulation-result", '<p class="notice notice-error">' + App.esc(App.t("plan.simulate.error_no_price")) + "</p>");
    return;
  }
  App.simResult = App.computeScenarios(App.state.data, amount, maintenance);
  App.simResult.item_name = App.$("#sim-name").value.trim();
  App.state.simSelectedScenario = "now";
  App.setHtml("#simulation-result", App.renderScenarios(App.simResult));
};

// ---------------------------------------------------------------- settings

App.renderSettingsTab = function () {
  App.setHtml("#view-settings", '<div class="neon-plan-section" style="display:flex;flex-direction:column;gap:0.875rem">' + App.renderSettings(App.state.data) + "</div>");
  var urlNode = App.$("#connection-url");
  if (urlNode && App.config) {
    urlNode.textContent = App.config.url.replace(/\/exec.*$/, "/exec");
  }
  App.checkForUpdate();
  var versionNode = App.$("#code-version");
  if (versionNode && App.state.data) {
    // Shown because forgetting "Phiên bản: Mới" on a redeploy fails silently -
    // the old code just keeps answering. Seeing the version is the only way to
    // catch it without guessing.
    versionNode.textContent = App.t("settings.code_version", { version: App.state.data.version || "?" });
  }
};

// A soft, non-blocking heads-up. The app works fine on an older Code.gs as
// long as the payload shape matches - only the newest features are missing -
// so this must never look like an error, just an offer.
App.checkForUpdate = function () {
  var node = App.$("#version-notice");
  if (!node || !App.state.data) return;
  var deployed = String(App.state.data.version || "");
  if (!deployed || deployed === App.EXPECTED_VERSION) return;

  node.innerHTML = '<p class="notice notice-info">' + App.t("settings.version_notice", {
    deployed: App.esc(deployed), expected: App.EXPECTED_VERSION,
  }) + "</p>";
};

// The token is the same thing as a password (it's all that guards writes to
// the sheet), so it stays masked by default even though it's already sitting
// in this browser's own localStorage - a shoulder-surfer shouldn't get it for
// free just because Settings is open.
App.maskToken = function (token) {
  var visible = token.length > 4 ? token.slice(0, 4) : "";
  var dots = "";
  for (var i = 0; i < Math.max(token.length - visible.length, 4); i++) dots += "\u2022";
  return visible + dots;
};

App.renderHealthConnectionInfo = function (result) {
  var url = (App.config && App.config.url) || "";
  var token = (App.config && App.config.token) || "";
  var revealed = !!App.state.healthTokenRevealed;

  var spreadsheetRow = "";
  if (result.spreadsheet_url) {
    spreadsheetRow = '<div class="health-connection-row"><span class="tiny muted">' +
      App.esc(App.t("settings.health_check_spreadsheet_label")) + '</span>' +
      '<a class="tiny" href="' + App.esc(result.spreadsheet_url) + '" target="_blank" rel="noopener">' +
      App.esc(App.t("settings.health_check_spreadsheet_link")) + "</a></div>";
  } else {
    spreadsheetRow = '<div class="health-connection-row"><span class="tiny muted">' +
      App.esc(App.t("settings.health_check_spreadsheet_label")) + '</span>' +
      '<span class="tiny faint">' + App.esc(App.t("settings.health_check_spreadsheet_unavailable")) + "</span></div>";
  }

  return '<div class="health-connection">' +
    '<p class="tiny muted" style="margin:0;font-weight:600">' + App.esc(App.t("settings.health_check_connection_title")) + "</p>" +
    '<div class="health-connection-row"><span class="tiny muted">' + App.esc(App.t("settings.health_check_url_label")) + "</span>" +
    '<span class="tiny num" style="word-break:break-all;text-align:right">' + App.esc(url) + "</span></div>" +
    spreadsheetRow +
    '<div class="health-connection-row"><span class="tiny muted">' + App.esc(App.t("settings.health_check_token_label")) + "</span>" +
    '<span class="tiny num" id="health-token-value">' + App.esc(revealed ? token : App.maskToken(token)) + "</span></div>" +
    '<div class="health-connection-actions" style="justify-content:flex-end;align-items:center">' +
    '<span class="tiny faint" id="health-token-copy-hint"></span>' +
    '<button type="button" class="secondary small" id="reveal-health-token">' +
    App.esc(revealed ? App.t("settings.health_check_token_hide") : App.t("settings.health_check_token_reveal")) + "</button>" +
    '<button type="button" class="secondary small" id="copy-health-token">' + App.esc(App.t("settings.health_check_token_copy")) + "</button>" +
    "</div></div>";
};

App.renderHealthCheckResult = function (result) {
  var rows = result.checks.map(function (check) {
    var mark = check.ok ? "\u2713" : (check.key === "gemini" ? "\u25cb" : "\u2717");
    var tone = check.ok ? "muted" : (check.key === "gemini" ? "faint" : "amount-out");
    return '<div class="kv kv-detail"><dt class="' + tone + '">' + mark + " " + App.esc(check.label) + "</dt>" +
      '<dd class="tiny ' + tone + '" style="font-family:var(--font-ui);font-weight:400">' +
      App.esc(check.detail || (check.ok ? App.t("settings.health_check_ok_detail") : "")) + "</dd></div>";
  }).join("");
  var headline = result.ok
    ? App.t("settings.health_check_ok_headline")
    : App.t("settings.health_check_fail_headline");
  return App.renderHealthConnectionInfo(result) +
    '<p class="notice notice-' + (result.ok ? "ok" : "info") + '">' + App.esc(headline) + "</p>" +
    '<dl class="stack-tight" style="margin-top:0.5rem">' + rows + "</dl>";
};

App.runHealthCheck = function () {
  App.notice("#setup-message", App.t("common.checking"), "info");
  App.apiGet("health_check")
    .then(function (result) {
      App.state.lastHealthCheck = result;
      App.state.healthTokenRevealed = false;
      App.setHtml("#setup-message", App.renderHealthCheckResult(result));
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

App.downloadCsv = function () {
  App.notice("#setup-message", App.t("settings.exporting"), "info");
  App.apiGet("export_csv")
    .then(function (result) {
      // The BOM matters: without it Excel on Windows renders Vietnamese
      // diacritics as mojibake. Every other reader ignores it.
      var blob = new Blob(["\ufeff" + result.csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "so-tai-chinh-" + App.today() + ".csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      App.notice("#setup-message", App.t("settings.exported_rows", { n: result.rows }), "ok");
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

App.runSetup = function (seed) {
  App.notice("#setup-message", App.t("settings.checking_spreadsheet"), "info");
  App.apiPost("setup", { seed: seed ? "1" : "0" })
    .then(function (result) {
      var parts = [];
      if (result.created.length) parts.push(App.t("settings.setup_created", { names: result.created.join(", ") }));
      if (result.repaired.length) parts.push(App.t("settings.setup_repaired", { names: result.repaired.join(", ") }));
      if (result.seeded && (result.seeded.accounts || result.seeded.categories)) {
        parts.push(App.t("settings.setup_seeded", { accounts: result.seeded.accounts, categories: result.seeded.categories }));
      }
      if (parts.length === 0) parts.push(App.t("settings.setup_nothing"));
      App.notice("#setup-message", parts.join(" "), "ok");
      return App.load({ quiet: true, data: result.bootstrap });
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

// ----------------------------------------------------------- AI on demand

App.askAi = function (topic, context, panelSelector, buttonSelector) {
  var panel = App.$(panelSelector);
  var button = App.$(buttonSelector);
  if (button) button.disabled = true;
  panel.classList.remove("hidden");
  panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("ai.eyebrow")) + '</span><p class="muted">' + App.esc(App.t("ai.thinking")) + "</p>";

  App.apiGet("get_ai_advice", { topic: topic, context: JSON.stringify(context) })
    .then(function (result) {
      if (!result.available) {
        panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("ai.eyebrow")) + '</span><p class="muted">' +
          App.esc(result.reason === "no_key" ? App.t("ai.no_key") : App.t("ai.generic_unavailable")) + "</p>";
        return;
      }
      panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("ai.eyebrow")) + "</span><p>" + App.esc(result.advice) + "</p>";
    })
    .catch(function (err) {
      panel.innerHTML = '<span class="eyebrow">' + App.esc(App.t("ai.eyebrow")) + '</span><p class="muted">' + App.esc(App.errorText(err)) + "</p>";
    })
    .finally(function () { if (button) button.disabled = false; });
};

// ------------------------------------------------------------ event wiring

// One delegated click handler for the whole app: views are re-rendered
// wholesale, so per-element listeners would need constant rebinding.
document.addEventListener("click", function (event) {
  // Every id in this selector must have a case below, and every case below
  // must have its id in this selector. A button added to one and not the
  // other renders perfectly and does nothing when clicked - which has already
  // shipped once. Audit both lists after touching either.
  var target = event.target.closest("[data-tab], [data-goto], [data-plan-section], [data-filter], " +
    "[data-dismiss-alert], [data-delete-tx], [data-edit-tx], [data-hide-goal], [data-hide-recurring], " +
    "[data-delete-rule], [data-edit-account], [data-apply-suggestion], [data-period-shift], [data-close-dialog], " +
    "[data-hide-income], [data-delete-event], [data-event-to-goal], [data-pick-category], [data-open-parent], " +
    "[data-pick-account], [data-pick-to-account], [data-toggle-tx], [data-dup-tx], [data-reset-tx-filters], " +
    "[data-goal-detail], [data-goal-back], [data-goal-quick], [data-pick-topup-account], " +
    "[data-notify-back], [data-notify-filter], [data-notify-read], [data-sim-scenario], " +
    "[data-set-theme], [data-set-palette], [data-set-lang], #add-event-item, #save-import, " +
    "#show-more, #save-budgets, #run-forecast, #run-simulation, #export-csv, #run-health-check, #run-setup-seed, " +
    "#reveal-health-token, #copy-health-token, " +
    "#reset-connection, #show-connection, #retry-load, #ai-goal-priority, #ai-simulation, #goal-topup-submit, " +
    "#save-connection-anyway, #device-link-btn, #copy-device-link, #theme-toggle, " +
    "#tx-today-btn, #tx-yesterday-btn, #tx-nudge, #home-bell, #home-networth-eye, #tx-sort-toggle, #tx-search-clear");
  if (!target) return;

  var attr = function (name) { return target.getAttribute(name); };

  if (attr("data-tab")) { App.switchTab(attr("data-tab")); return; }

  // Drilling into a parent is checked BEFORE selection: a parent that has
  // children opens them, and is selectable on its own only from inside.
  // hasAttribute, not the value - the "quay lại" tile carries an empty one.
  if (target.hasAttribute("data-open-parent")) {
    App.state.categoryParent = attr("data-open-parent");
    App.renderCategoryGrid();
    return;
  }
  if (attr("data-pick-category")) { App.pickCategory(attr("data-pick-category")); return; }
  if (attr("data-pick-account")) { App.pickAccount(attr("data-pick-account")); return; }
  if (attr("data-pick-to-account")) { App.pickToAccount(attr("data-pick-to-account")); return; }

  if (attr("data-set-theme")) { App.setTheme(attr("data-set-theme")); App.renderSettingsTab(); return; }
  if (attr("data-set-palette")) { App.setPalette(attr("data-set-palette")); App.renderSettingsTab(); return; }
  // Language changes what almost every visible string says, so the whole
  // current tab is re-rendered, not just Settings - plus the static markup
  // (tab bar, the Add form's own labels) that never goes through a view.
  if (attr("data-set-lang")) {
    App.setLang(attr("data-set-lang"));
    App.applyStaticI18n();
    App.renderCurrentTab();
    return;
  }

  if (attr("data-goto")) {
    var parts = attr("data-goto").split(":");
    // Only "plan:<section>" means a plan sub-section; "add:import" is the
    // one other compound target (Nhà's "Nhập ảnh" quick action), which just
    // switches tabs and then scrolls to the already-present import card.
    if (parts[0] === "plan" && parts[1]) App.state.planSection = parts[1];
    App.switchTab(parts[0]);
    if (parts[0] === "add" && parts[1] === "import") {
      window.setTimeout(function () {
        var importCard = App.$("#import-file");
        if (importCard && importCard.scrollIntoView) importCard.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 0);
    }
    return;
  }

  // hasAttribute, not the value: the "☰" chip carries an empty one, which is
  // how it returns to the hub.
  if (target.hasAttribute("data-plan-section")) {
    App.state.planSection = attr("data-plan-section") || null;
    App.renderPlan();
    // Keep the chosen chip in view instead of letting the row snap back.
    var chip = App.$('[data-plan-section="' + attr("data-plan-section") + '"]');
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: "nearest", inline: "center" });
    return;
  }
  if (attr("data-filter")) { App.state.txFilter = attr("data-filter"); App.state.txLimit = 40; App.renderList(); return; }

  if (target.hasAttribute("data-reset-tx-filters")) {
    App.state.txFilter = "all"; App.state.txQuery = ""; App.state.txCategory = ""; App.state.txAccount = "";
    App.state.txLimit = 40;
    App.renderList();
    return;
  }

  if (attr("data-toggle-tx")) {
    var toggleId = attr("data-toggle-tx");
    App.state.txOpenId = String(App.state.txOpenId) === String(toggleId) ? null : toggleId;
    App.renderList();
    return;
  }

  // Duplicate re-posts today, not the original date - "log the same coffee
  // again" is the use case, not "backdate a correction". Transfer rows have
  // no duplicate button at all: each is one leg of a linked pair, and
  // duplicating a single leg would silently create an unbalanced entry.
  if (attr("data-dup-tx")) {
    var srcTx = App.state.data.transactions.filter(function (t) { return String(t.id) === String(attr("data-dup-tx")); })[0];
    if (!srcTx || srcTx.is_transfer) return;
    App.apiPost("add_transaction", {
      direction: srcTx.direction, account_id: srcTx.account_id, category_id: srcTx.category_id,
      amount: String(srcTx.amount), description: srcTx.description, occurred_at: App.today(),
    })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  // Dismissing an alert only hides it for this visit - there is no "muted"
  // state anywhere, so a condition that is still true comes back next load.
  // That's deliberate: an ongoing risk shouldn't be silenceable by a tap.
  if (attr("data-dismiss-alert")) { target.closest(".alert").remove(); return; }

  if (attr("data-delete-tx")) {
    if (!window.confirm(App.t("confirm.delete_transaction"))) return;
    App.apiPost("delete_transaction", { id: attr("data-delete-tx") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-edit-tx")) { App.openEditDialog(attr("data-edit-tx")); return; }
  // hasAttribute, not the value - it's a bare boolean attribute (no ="..."),
  // so getAttribute() returns "" here, which is falsy and would silently
  // never match. Same bug class as data-reset-tx-filters/data-open-parent.
  if (target.hasAttribute("data-close-dialog")) { App.closeDialog(); return; }

  if (attr("data-hide-goal")) {
    if (!window.confirm(App.t("confirm.hide_goal"))) return;
    App.apiPost("deactivate_goal", { id: attr("data-hide-goal") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-goal-detail")) { App.state.goalDetailId = attr("data-goal-detail"); App.renderPlan(); return; }
  if (target.hasAttribute("data-goal-back")) { App.state.goalDetailId = null; App.renderPlan(); return; }

  if (attr("data-goal-quick")) {
    var quickGoal = App.state.data.goals.filter(function (g) { return String(g.id) === String(App.state.goalDetailId); })[0];
    var quickVal = attr("data-goal-quick") === "rest" ? String(Math.max(0, quickGoal ? quickGoal.remaining_amount : 0)) : attr("data-goal-quick");
    App.$("#goal-topup-amount").value = App.formatVnd(quickVal);
    return;
  }

  if (attr("data-pick-topup-account")) {
    App.$("#goal-topup-account").value = attr("data-pick-topup-account");
    App.$$("#goal-topup-account-chips .neon-chip").forEach(function (chip) {
      chip.setAttribute("aria-pressed", String(chip.getAttribute("data-pick-topup-account") === attr("data-pick-topup-account")));
    });
    return;
  }

  if (target.hasAttribute("data-notify-back")) { App.state.notificationsOpen = false; App.renderCurrentTab(); return; }
  if (attr("data-notify-filter")) { App.state.notificationFilter = attr("data-notify-filter"); App.renderCurrentTab(); return; }
  if (attr("data-notify-read")) {
    App.state.readNotifications[attr("data-notify-read")] = true;
    App.renderCurrentTab();
    return;
  }

  if (attr("data-sim-scenario")) {
    App.state.simSelectedScenario = attr("data-sim-scenario");
    App.setHtml("#simulation-result", App.renderScenarios(App.simResult));
    return;
  }

  if (attr("data-hide-recurring")) {
    if (!window.confirm(App.t("confirm.stop_recurring"))) return;
    App.apiPost("deactivate_recurring", { id: attr("data-hide-recurring") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-delete-rule")) {
    if (!window.confirm(App.t("confirm.delete_rule"))) return;
    App.apiPost("delete_rule", { id: attr("data-delete-rule") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-edit-account")) { App.openAccountDialog(attr("data-edit-account")); return; }

  if (attr("data-hide-income")) {
    if (!window.confirm(App.t("confirm.hide_income"))) return;
    App.apiPost("deactivate_income_source", { id: attr("data-hide-income") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-delete-event")) {
    if (!window.confirm(App.t("confirm.delete_event"))) return;
    App.apiPost("delete_event_plan", { id: attr("data-delete-event") })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  // Turning an event into a goal: create the goal, then link it back so the
  // suggestion never reappears for that event.
  if (attr("data-event-to-goal")) { App.createGoalFromEvent(attr("data-event-to-goal")); return; }

  if (attr("data-apply-suggestion")) {
    var field = App.$("#budget-" + attr("data-apply-suggestion"));
    if (field) { field.value = attr("data-amount"); field.focus(); }
    return;
  }

  if (attr("data-period-shift")) {
    var base = App.state.data.period.id;
    App.state.periodId = App.shiftPeriodId(base, Number(attr("data-period-shift")));
    App.load({ quiet: true });
    return;
  }

  switch (target.id) {
    case "show-more": App.state.txLimit += 40; App.renderList(); break;
    case "tx-sort-toggle":
      App.state.txSort = App.state.txSort === "desc" ? "asc" : "desc";
      App.renderList();
      break;
    case "tx-search-clear":
      App.state.txQuery = "";
      App.state.txLimit = 40;
      App.renderList();
      break;
    case "save-budgets": App.saveBudgets(); break;
    case "run-forecast": App.runForecast(); break;
    case "run-simulation": App.runSimulation(); break;
    case "export-csv": App.downloadCsv(); break;
    case "run-health-check": App.runHealthCheck(); break;
    case "reveal-health-token":
      if (!App.state.lastHealthCheck) break;
      App.state.healthTokenRevealed = !App.state.healthTokenRevealed;
      App.setHtml("#setup-message", App.renderHealthCheckResult(App.state.lastHealthCheck));
      break;
    case "copy-health-token":
      navigator.clipboard.writeText((App.config && App.config.token) || "").then(function () {
        var hint = App.$("#health-token-copy-hint");
        if (!hint) return;
        hint.textContent = App.t("settings.health_check_token_copied");
        setTimeout(function () { if (hint) hint.textContent = ""; }, 1500);
      }).catch(function () {});
      break;
    case "run-setup-seed": App.runSetup(true); break;
    case "save-connection-anyway":
      App.saveConfig(App.pendingConfig);
      location.reload();
      break;
    case "device-link-btn": App.showDeviceLink(); break;
    case "copy-device-link":
      App.$("#device-link").select();
      navigator.clipboard.writeText(App.$("#device-link").value).then(function () {
        App.notice("#device-link-message", App.t("dialog.device_link.copied"), "ok");
      }).catch(function () {
        App.notice("#device-link-message", App.t("dialog.device_link.copy_failed"), "info");
      });
      break;
    case "theme-toggle": App.cycleTheme(); App.updateThemeButton(); break;
    case "retry-load": App.showLoading(); App.load(); break;
    case "save-import": App.saveImport(); break;
    case "add-event-item": App.$("#event-items").insertAdjacentHTML("beforeend", App.eventItemRow("", false)); break;
    case "show-connection": App.showConnectionForm(); break;
    case "reset-connection":
      if (window.confirm(App.t("confirm.reset_connection"))) {
        App.clearConfig();
        location.reload();
      }
      break;
    case "ai-goal-priority":
      App.askAi("goals", App.state.data.goals.map(function (goal) {
        return {
          ten: goal.name, loai: goal.goal_type, con_thieu: goal.remaining_amount,
          so_ky_con_lai: goal.periods_remaining, can_moi_ky: goal.required_per_period,
          dang_cham: goal.is_off_track || goal.is_overdue,
        };
      }), "#ai-goals", "#ai-goal-priority");
      break;
    case "ai-simulation":
      App.askAi("simulation", {
        gia: App.simResult.total_cost,
        so_du_hien_tai: App.simResult.starting_balance,
        cac_phuong_an: App.simResult.scenarios.map(function (s) {
          return {
            ten: s.label, so_du_thap_nhat: s.lowest_balance, den_tin_hieu: s.traffic_light,
            ky_dau_tien_am_quy: s.first_negative,
          };
        }),
      }, "#ai-sim-panel", "#ai-simulation");
      break;
    case "tx-today-btn": App.setTodayDate(); break;
    case "tx-yesterday-btn": App.setYesterdayDate(); break;
    // The alert banners already render at the very top of Nhà - the bell is
    // a shortcut to them, not a separate inbox this app doesn't have.
    case "home-bell": App.state.notificationsOpen = true; App.renderCurrentTab(); break;
    case "home-networth-eye":
      localStorage.setItem(App.NET_WORTH_HIDDEN_KEY, App.netWorthHidden() ? "0" : "1");
      App.renderCurrentTab();
      break;
    case "tx-nudge":
      event.preventDefault();
      var nudgeAmount = App.$("#tx-amount").value.trim();
      var nudgeName = App.$("#tx-description").value.trim();
      App.state.planSection = "simulate";
      App.switchTab("plan");
      window.setTimeout(function () {
        var amountField = App.$("#sim-amount");
        if (amountField) {
          amountField.value = nudgeAmount;
          App.$("#sim-name").value = nudgeName;
        }
      }, 0);
      break;
    case "goal-topup-submit": App.submitGoalTopup(target); break;
  }
});

// A top-up is recorded the same way any other transfer is: two linked
// legs via add_transfer, never a special "goal contribution" write path.
// That's what makes it show up as an ordinary internal transfer everywhere
// else in the app (Sổ, the transfer-exclusion in every risk metric) rather
// than a parallel kind of money movement with its own rules.
App.submitGoalTopup = function (button) {
  var goalId = button.getAttribute("data-goal-id");
  var goal = App.state.data.goals.filter(function (g) { return String(g.id) === String(goalId); })[0];
  if (!goal) return;

  var rawAmount = App.$("#goal-topup-amount").value.trim();
  var fromAccount = App.$("#goal-topup-account").value;
  var parsed = App.tryParseAmount(rawAmount);
  if (!rawAmount || parsed === null || parsed <= 0) {
    App.notice("#goal-topup-message", App.t("add.error_amount_required"), "error");
    return;
  }
  if (!fromAccount || String(fromAccount) === String(goal.account_id)) {
    App.notice("#goal-topup-message", App.t("add.error_same_account"), "error");
    return;
  }

  button.disabled = true;
  App.notice("#goal-topup-message", "", "info");
  App.apiPost("add_transfer", {
    from_account_id: fromAccount, to_account_id: goal.account_id,
    amount: rawAmount, description: App.t("plan.goals.topup_description", { name: goal.name }),
    occurred_at: App.today(),
  })
    .then(function (result) {
      if (App.$("#goal-topup-submit")) App.$("#goal-topup-submit").disabled = false;
      App.notice("#goal-topup-message", App.t("plan.goals.topup_saved"), "ok");
      App.load({ quiet: true, data: result.bootstrap });
    })
    .catch(function (err) {
      if (App.$("#goal-topup-submit")) App.$("#goal-topup-submit").disabled = false;
      App.notice("#goal-topup-message", App.errorText(err), "error");
    });
};

// Forms: also delegated, for the same re-render reason.
document.addEventListener("submit", function (event) {
  var form = event.target;
  // Read the id via getAttribute, never off the element directly. A form's
  // named controls are exposed as properties on the form, so a field named
  // "id" (edit-form and account-edit-form both have one) shadows the element's
  // own id with that input - every comparison against a string then silently
  // fails, no branch runs, nothing calls preventDefault, and the browser does
  // a real page navigation with the whole form in the query string. Both edit
  // dialogs were dead this way until it was caught.
  var formId = form.getAttribute("id");
  var body = {};
  new FormData(form).forEach(function (value, key) { body[key] = value; });

  function post(action, messageSelector, successText) {
    event.preventDefault();
    App.notice(messageSelector, "Đang lưu…", "info");
    App.apiPost(action, body)
      .then(function (result) {
        // Confirm the moment the write itself lands - the reload that follows
        // just refreshes the list/numbers around this form (which is its own
        // visible confirmation), it doesn't need to gate this message too.
        form.reset();
        App.notice(messageSelector, successText, "ok");
        App.load({ quiet: true, data: result.bootstrap });
      })
      .catch(function (err) { App.notice(messageSelector, App.errorText(err), "error"); });
  }

  if (formId === "income-form") post("add_income_source", "#income-message", App.t("plan.income.added"));
  else if (formId === "event-form") {
    event.preventDefault();
    var items = App.collectEventItems();
    if (items.length === 0) {
      App.notice("#event-message", App.t("plan.events.need_one_item"), "error");
      return;
    }
    App.notice("#event-message", App.t("common.saving"), "info");
    App.apiPost("add_event_plan", { name: body.name, event_date: body.event_date, items: items })
      .then(function (result) {
        form.reset();
        App.notice("#event-message", App.t("plan.events.saved"), "ok");
        App.load({ quiet: true, data: result.bootstrap });
      })
      .catch(function (err) { App.notice("#event-message", App.errorText(err), "error"); });
  }
  else if (formId === "goal-form") post("add_goal", "#goal-message", App.t("plan.goals.created"));
  else if (formId === "recurring-form") post("add_recurring", "#recurring-message", App.t("plan.recurring.added"));
  else if (formId === "account-form") post("add_account", "#account-message", App.t("settings.account_added"));
  else if (formId === "category-form") post("add_category", "#category-message", App.t("settings.category_added"));
  else if (formId === "rule-form") post("add_rule", "#rule-message", App.t("settings.rule_added"));
  else if (formId === "edit-form") {
    event.preventDefault();
    App.notice("#edit-message", App.t("common.saving"), "info");
    var learnRule = body.learn_rule === "1" && String(body.learn_pattern || "").trim() && body.category_id;
    var pattern = String(body.learn_pattern || "").trim();
    var categoryForRule = body.category_id;
    delete body.learn_rule;
    delete body.learn_pattern;

    var lastResult = null;
    App.apiPost("update_transaction", body)
      .then(function (result) {
        lastResult = result;
        // Saving the rule is a follow-up, never a precondition: if it fails,
        // the edit the user actually asked for has already landed.
        if (!learnRule) return null;
        return App.apiPost("add_rule", {
          pattern: pattern, category_id: categoryForRule, priority: 10, created_from: "learned",
        }).then(function (result) { lastResult = result; }).catch(function () { return null; });
      })
      .then(function () {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true, data: lastResult && lastResult.bootstrap });
      })
      .catch(function (err) { App.notice("#edit-message", App.errorText(err), "error"); });
  } else if (formId === "account-edit-form") {
    event.preventDefault();
    App.notice("#account-edit-message", App.t("common.saving"), "info");
    App.apiPost("update_account", body)
      .then(function (result) {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true, data: result.bootstrap });
      })
      .catch(function (err) { App.notice("#account-edit-message", App.errorText(err), "error"); });
  } else if (formId === "event-goal-form") {
    event.preventDefault();
    App.notice("#event-goal-message", App.t("common.creating"), "info");
    var eventId = body.event_id;
    delete body.event_id;
    App.apiPost("add_goal", body)
      .then(function (result) {
        // Link second: if this fails the goal still exists, and the worst case
        // is the suggestion showing once more - not a lost goal.
        return App.apiPost("link_event_to_goal", { id: eventId, goal_id: result.id });
      })
      .then(function (linkResult) {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true, data: linkResult.bootstrap });
      })
      .catch(function (err) { App.notice("#event-goal-message", App.errorText(err), "error"); });
  } else if (formId === "connection-form") {
    event.preventDefault();
    var url = body.url.trim();
    var token = body.token.trim();
    if (!url || !token) {
      App.notice("#connection-message", App.t("dialog.connection.need_both"), "error");
      return;
    }
    if (url.indexOf("/exec") === -1) {
      App.notice("#connection-message", App.t("dialog.connection.bad_url"), "error");
      return;
    }

    // Check the URL BEFORE saving it. Pasting a link to an older deployment
    // and only finding out from a broken screen afterwards is the exact loop
    // this avoids - a deployment answers `version` without a token, so this
    // costs nothing and needs no credentials.
    App.notice("#connection-message", App.t("dialog.connection.checking_url"), "info");
    var timeout = new Promise(function (resolve) { window.setTimeout(function () { resolve("timeout"); }, 20000); });

    Promise.race([App.fetchVersionFor(url), timeout]).then(function (version) {
      if (version === App.EXPECTED_VERSION) {
        App.saveConfig({ url: url, token: token });
        location.reload();
        return;
      }
      // Anything else still saves - the app works on older code, and a slow
      // cold start must not stop someone connecting - but say what was found.
      var warning = version === "timeout"
        ? App.t("dialog.connection.timeout_warning")
        : (version
            ? App.t("dialog.connection.version_warning", { version: version, expected: App.EXPECTED_VERSION })
            : App.t("dialog.connection.too_old_warning"));
      App.setHtml("#connection-message",
        '<p class="notice notice-info">' + App.esc(warning) +
        App.esc(App.t("dialog.connection.still_works")) +
        '</p><button type="button" class="secondary" id="save-connection-anyway">' + App.esc(App.t("dialog.connection.save_anyway")) + "</button>");
      App.pendingConfig = { url: url, token: token };
    });
  } else if (formId === "tx-form") {
    event.preventDefault();
    App.submitTransaction();
  }
});

document.addEventListener("input", function (event) {
  // Every money field in the app is an inputmode=numeric text box, so one
  // delegated handler covers the add form, the edit dialog, budgets, goals,
  // income, event items and the import review rows alike.
  if (event.target.matches && event.target.matches('input[inputmode="numeric"]')) {
    App.formatAmountInput(event.target);
  }
  if (event.target.id === "tx-amount") App.updateAmountHint();
  if (event.target.id === "tx-search") {
    App.state.txQuery = event.target.value;
    App.state.txLimit = 40;
    var caret = event.target.selectionStart;
    App.renderList();
    var refocused = App.$("#tx-search");
    refocused.focus();
    refocused.setSelectionRange(caret, caret);
  }
});

document.addEventListener("change", function (event) {
  if (event.target.name === "direction" && event.target.closest("#tx-form")) {
    // Chi and Thu draw from different halves of the category tree, so a
    // choice made under one direction is meaningless under the other.
    App.state.categoryId = "";
    App.state.categoryParent = "";
    App.refreshAddForm();
  }
  if (event.target.id === "tx-date") App.updateDateDisplay();
  if (event.target.id === "event-template") App.resetEventItems(event.target.value);
  if (event.target.id === "tx-category-filter") {
    App.state.txCategory = event.target.value; App.state.txLimit = 40; App.renderList();
  }
  if (event.target.id === "tx-account-filter") {
    App.state.txAccount = event.target.value; App.state.txLimit = 40; App.renderList();
  }
  if (event.target.id === "import-file" && event.target.files && event.target.files.length) {
    App.analyzeImages(event.target.files);
  }

  // Recording an actual amount on an event item saves straight away - it is a
  // single number, and a separate save button for each row would be friction.
  if (event.target.hasAttribute && event.target.hasAttribute("data-event-item")) {
    var input = event.target;
    App.apiPost("update_event_item", { id: input.getAttribute("data-event-item"), actual_amount: input.value })
      .then(function (result) { return App.load({ quiet: true, data: result.bootstrap }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
  }
});

// --------------------------------------------------------- account dialog

App.openAccountDialog = function (id) {
  var account = App.state.data.accounts.filter(function (a) { return String(a.id) === String(id); })[0];
  if (!account) return;

  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>' + App.esc(App.t("dialog.edit_account.title")) + '</h2>' +
    '<button type="button" class="icon-btn" data-close-dialog aria-label="' + App.esc(App.t("dialog.edit_tx.close_aria")) + '">\u2715</button></div>' +
    '<form id="account-edit-form">' +
      '<input type="hidden" name="id" value="' + App.esc(account.id) + '">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_account.name_label")) + '</span>' +
      '<input type="text" name="name" value="' + App.esc(account.name) + '"></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_account.type_label")) + '</span><select name="type">' +
        Object.keys(App.LABEL_MAPS.account_type.vi).map(function (key) {
          return '<option value="' + key + '"' + (key === account.type ? " selected" : "") + ">" +
            App.esc(App.label("account_type", key)) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_account.balance_label")) + '</span>' +
      '<input type="text" inputmode="numeric" name="balance" value="' + App.esc(App.formatVnd(account.balance)) + '"></label>' +
      '<p class="tiny muted">' + App.esc(App.t("dialog.edit_account.balance_hint")) + "</p>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.edit_account.visibility_label")) + '</span><select name="is_active">' +
        '<option value="1">' + App.esc(App.t("dialog.edit_account.visibility_active")) + '</option><option value="0">' + App.esc(App.t("dialog.edit_account.visibility_hidden")) + "</option>" +
      "</select></label>" +
      "<button type=\"submit\">" + App.esc(App.t("dialog.edit_account.submit")) + "</button>" +
      '<div id="account-edit-message"></div>' +
    "</form>"
  );
  App.$("#tx-dialog").showModal();
};

// The event → goal bridge. An event says "I owe this much on this date"; a
// goal says "put this much aside each period". Creating one from the other
// carries the amount and the deadline across, then links them so the app
// stops suggesting it again.
App.createGoalFromEvent = function (eventId) {
  var event = App.state.data.events.filter(function (e) { return String(e.id) === String(eventId); })[0];
  if (!event) return;

  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>' + App.esc(App.t("dialog.event_goal.title")) + '</h2>' +
    '<button type="button" class="icon-btn" data-close-dialog aria-label="' + App.esc(App.t("dialog.edit_tx.close_aria")) + '">\u2715</button></div>' +
    '<form id="event-goal-form">' +
      '<input type="hidden" name="event_id" value="' + App.esc(event.id) + '">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.event_goal.name_label")) + '</span>' +
      '<input type="text" name="name" value="' + App.esc(event.name) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.event_goal.target_label")) + '</span>' +
      '<input type="text" inputmode="numeric" name="target_amount" value="' + App.esc(App.formatVnd(event.remaining_total)) + '" required>' +
      '<span class="tiny faint">' + App.esc(App.t("dialog.event_goal.target_hint")) + "</span></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.event_goal.deadline_label")) + '</span>' +
      '<input type="date" name="deadline" value="' + App.esc(event.event_date) + '" required></label>' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.event_goal.account_label")) + '</span>' +
      "<select name=\"account_id\">" + App.accountOptions(App.state.data.accounts, null, true) + "</select></label>" +
      '<input type="hidden" name="goal_type" value="savings">' +
      '<p class="tiny muted">' + App.esc(App.t("dialog.event_goal.split_hint", {
        amount: App.formatDong(event.remaining_total),
        periods: Math.max(event.periods_until, 1),
        perPeriod: App.formatDong(Math.round(event.remaining_total / Math.max(event.periods_until, 1))),
      })) + "</p>" +
      "<button type=\"submit\">" + App.esc(App.t("dialog.event_goal.submit")) + "</button>" +
      '<div id="event-goal-message"></div>' +
    "</form>");
  App.$("#tx-dialog").showModal();
};

App.showConnectionForm = function () {
  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>' + App.esc(App.t("dialog.connection.title")) + '</h2>' +
    '<button type="button" class="icon-btn" data-close-dialog aria-label="' + App.esc(App.t("dialog.edit_tx.close_aria")) + '">\u2715</button></div>' +
    '<form id="connection-form">' +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.connection.url_label")) + '</span>' +
      '<input type="text" name="url" value="' + App.esc(App.config ? App.config.url : "") +
      '" placeholder="https://script.google.com/macros/s/\u2026/exec" required>' +
      '<span class="tiny faint">' + App.esc(App.t("dialog.connection.url_hint")) + "</span></label>" +
      '<label class="field"><span class="field-label">' + App.esc(App.t("dialog.connection.token_label")) + '</span>' +
      '<input type="password" name="token" value="' + App.esc(App.config ? App.config.token : "") +
      '" autocomplete="current-password" required>' +
      '<span class="tiny faint">' + App.esc(App.t("dialog.connection.token_hint")) + "</span></label>" +
      "<button type=\"submit\">" + App.esc(App.t("dialog.connection.submit")) + "</button>" +
      '<div id="connection-message"></div>' +
    "</form>"
  );
  App.$("#tx-dialog").showModal();
};

App.updateThemeButton = function () {
  var button = App.$("#theme-toggle");
  if (button) button.title = App.t("settings.appearance_title") + ": " + App.label("theme", App.currentTheme());
};

// ------------------------------------------------------------ connect link

// A connection can be handed over in the URL fragment: #url=…&token=….
// The fragment is chosen deliberately over a query string - browsers never
// send it to the server, so GitHub Pages never sees the token, and it stays
// out of server logs entirely. It is still a password in a link, so the UI
// that generates one says so plainly and the hash is wiped from the address
// bar the moment it has been read.
App.readConnectLink = function () {
  var hash = String(location.hash || "").replace(/^#/, "");
  if (!hash) return null;
  var params = new URLSearchParams(hash);
  var url = params.get("url");
  if (!url) return null;
  return { url: url.trim(), token: (params.get("token") || "").trim() };
};

App.clearConnectLink = function () {
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, "", location.pathname + location.search);
  } else {
    location.hash = "";
  }
};

// Built from the config already in this browser, so the token never leaves
// the device except into a link the user chooses to move.
App.showDeviceLink = function () {
  var link = location.origin + location.pathname +
    "#url=" + encodeURIComponent(App.config.url) + "&token=" + encodeURIComponent(App.config.token);

  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>' + App.esc(App.t("dialog.device_link.title")) + '</h2>' +
    '<button type="button" class="icon-btn" data-close-dialog aria-label="' + App.esc(App.t("dialog.edit_tx.close_aria")) + '">\u2715</button></div>' +
    '<p class="small muted">' + App.esc(App.t("dialog.device_link.intro")) + "</p>" +
    '<textarea id="device-link" rows="4" readonly style="font-family:var(--font-num);font-size:0.75rem">' +
    App.esc(link) + "</textarea>" +
    '<button type="button" id="copy-device-link">' + App.esc(App.t("dialog.device_link.copy")) + "</button>" +
    '<p class="notice notice-info">' + App.t("dialog.device_link.warning") + "</p>" +
    '<div id="device-link-message"></div>');
  App.$("#tx-dialog").showModal();
};

// -------------------------------------------------------------------- boot

(function boot() {
  App.config = App.loadConfig();
  App.updateThemeButton();
  document.documentElement.setAttribute("lang", App.currentLang());
  App.applyStaticI18n();

  // A #url=…&token=… link connects this device outright; a link with only the
  // URL just pre-fills it, which is the safe form to pass around in writing.
  var link = App.readConnectLink();
  if (link) {
    App.clearConnectLink();
    if (link.token) {
      App.config = { url: link.url, token: link.token };
      App.saveConfig(App.config);
    } else {
      App.pendingPrefillUrl = link.url;
    }
  }

  if (!App.config || !App.config.url || !App.config.token) {
    App.show("#onboarding", true);
    App.show("#app-shell", false);
    if (App.pendingPrefillUrl) {
      var field = App.$('#onboarding [name="url"]');
      if (field) field.value = App.pendingPrefillUrl;
    }
    return;
  }
  App.show("#onboarding", false);
  App.show("#app-shell", true);
  App.switchTab("home");
  App.showLoading();
  App.load();

  // Already connected, but arrived on a link carrying a different address -
  // open the connection form pre-filled rather than switching silently.
  if (App.pendingPrefillUrl && App.pendingPrefillUrl !== App.config.url) {
    App.showConnectionForm();
    var pending = App.$('#tx-dialog [name="url"]');
    if (pending) pending.value = App.pendingPrefillUrl;
  }
})();
