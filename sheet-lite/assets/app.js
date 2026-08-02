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
  planSection: "budget",
  txFilter: "all",
  txQuery: "",
  txLimit: 40,
  periodId: null,
  loading: false,
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
    { key: "none", label: "Không mua", projection: baseline },
    { key: "now", label: "Trả hết ngay", projection: project(function (i) { return (i === 0 ? itemAmount : 0) + maintenance; }) },
  ];

  App.INSTALLMENT_OPTIONS.forEach(function (n) {
    scenarios.push({
      key: "installment_" + n,
      label: "Trả góp " + n + " kỳ",
      projection: project(function (i) { return (i < n ? itemAmount / n : 0) + maintenance; }),
    });
  });

  App.DELAY_OPTIONS.forEach(function (n) {
    scenarios.push({
      key: "delay_" + n,
      label: "Hoãn " + n + " kỳ rồi trả hết",
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
App.LOADING_HINTS = [
  [0, "Lần đầu trong ngày thường mất vài giây."],
  [6000, "Vẫn đang chờ Google phản hồi. Lần gọi đầu sau khi triển khai có thể mất tới một phút — đây là bình thường, không phải lỗi."],
  [45000, "Lâu hơn thường lệ. Nếu quá 2 phút, kiểm tra bản triển khai có đang mở cho “Bất kỳ ai có đường liên kết” không."],
];

App.clearLoadingTimers = function () {
  (App.loadingTimers || []).forEach(window.clearTimeout);
  App.loadingTimers = [];
};

App.showLoading = function () {
  App.clearLoadingTimers();
  function paint(hint) {
    App.setHtml("#view-home",
      '<section class="card">' +
        '<span class="eyebrow">Đang tải</span>' +
        "<h1>Đang mở sổ từ Google Sheet…</h1>" +
        '<p class="small muted">' + App.esc(hint) + "</p>" +
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
      '<span class="eyebrow">Không mở được sổ</span>' +
      "<h1>" + App.esc(title) + "</h1>" +
      '<div class="small muted stack-tight">' + messageHtml + "</div>" +
      '<div class="button-row">' +
        '<button type="button" id="retry-load">Thử lại</button>' +
        '<button type="button" class="secondary" id="show-connection">Đổi kết nối</button>' +
      "</div>" +
    "</section>";
  App.switchTab("home");
};

App.load = function (options) {
  var opts = options || {};
  App.state.loading = true;
  var params = App.state.periodId ? { period_id: App.state.periodId } : {};

  return App.apiGet("bootstrap", params)
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
          App.showFatal("Bảng tính đang chạy mã cũ hơn giao diện",
            "<p><b>Điểm mấu chốt:</b> Apps Script phục vụ <u>phiên bản đã triển khai</u>, " +
            "không phải code đang nằm trong trình soạn thảo. Dán code mới vào mà không tạo " +
            "phiên bản mới thì URL vẫn chạy code cũ, và nó không báo lỗi gì cả.</p>" +
            "<p>Đang chạy: <b>" + (deployed ? "v" + App.esc(deployed) : "bản cũ hơn v3.4") +
            "</b> · Giao diện cần: <b>v" + App.EXPECTED_VERSION + "</b></p>" +
            "<p>Trong Apps Script, làm đúng thứ tự này:</p>" +
            "<p>1. Dán <code>Code.gs</code> mới nhất, bấm <b>lưu</b> (biểu tượng đĩa mềm 💾). " +
            "Chưa lưu thì bước sau sẽ triển khai lại đúng code cũ.<br>" +
            "2. <b>Triển khai → Quản lý bản triển khai</b><br>" +
            "3. Bấm <b>biểu tượng bút chì ✏</b> ở bản triển khai đang dùng<br>" +
            "4. Ô <b>Phiên bản</b> đang là một con số — đổi thành <b>Phiên bản mới</b><br>" +
            "5. Bấm <b>Triển khai</b>, rồi quay lại đây bấm <b>Thử lại</b></p>" +
            "<p>Nếu bạn có nhiều bảng tính, hãy chắc chắn đã dán code vào đúng cái mà URL này trỏ tới — " +
            "không thì bấm “Đổi kết nối”.</p>");
        });
        return null;
      }

      App.state.fatalHtml = null;
      App.state.data = data;
      App.renderCurrentTab();
      App.updateTopbar();
      if (!opts.quiet && data.recurring_generated > 0) {
        window.setTimeout(function () {
          App.notice("#add-message", "Đã tự ghi " + data.recurring_generated + " khoản định kỳ đến hạn.", "info");
        }, 0);
      }
      return data;
    })
    .catch(function (err) {
      App.state.loading = false;
      App.showFatal("Chưa tải được dữ liệu", "<p>" + App.esc(App.errorText(err)) + "</p>");
    });
};

// ------------------------------------------------------------------ topbar

App.updateTopbar = function () {
  var data = App.state.data;
  if (!data) return;
  App.setHtml(
    "#period-chip",
    "Kỳ " + App.esc(App.formatPeriodRange(data.period)) + " · còn " + data.period.days_remaining + " ngày"
  );
};

// -------------------------------------------------------------------- tabs

App.TABS = ["home", "add", "list", "plan", "settings"];

App.switchTab = function (tab) {
  App.state.tab = tab;
  App.TABS.forEach(function (name) {
    App.show("#view-" + name, name === tab);
    var button = App.$('[data-tab="' + name + '"]');
    if (button) button.setAttribute("aria-selected", String(name === tab));
  });
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
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
    if (App.state.tab === "home") App.setHtml("#view-home", App.renderDashboard(data)), App.loadDailySummary();
    else if (App.state.tab === "add") App.refreshAddForm();
    else if (App.state.tab === "list") App.renderList();
    else if (App.state.tab === "plan") App.renderPlan();
    else if (App.state.tab === "settings") App.renderSettingsTab();
  } catch (err) {
    App.showFatal("Giao diện gặp lỗi khi hiển thị dữ liệu",
      "<p>" + App.esc(String((err && err.message) || err)) + "</p>" +
      "<p>Thường là do mã <code>Code.gs</code> trên Google Sheet cũ hơn trang này. " +
      "Dán lại bản mới rồi triển khai với <b>Phiên bản: Mới</b>.</p>");
  }
};

// --------------------------------------------------------------- dashboard

App.aiSummaryLoadedFor = null;

App.loadDailySummary = function () {
  var panel = App.$("#ai-daily");
  if (!panel) return;
  var today = App.today();

  // One call per day per page session: the summary only changes daily, and
  // Apps Script calls are slow enough that re-fetching on every tab switch
  // would be felt.
  if (App.aiSummaryCache && App.aiSummaryLoadedFor === today) {
    panel.innerHTML = '<span class="eyebrow">Nhận xét hôm nay</span><p>' + App.esc(App.aiSummaryCache) + "</p>";
    panel.classList.remove("hidden");
    return;
  }
  if (App.aiSummaryLoadedFor === today) return; // tried already, unavailable

  panel.innerHTML = '<span class="eyebrow">Nhận xét hôm nay</span><p class="muted">Đang đọc số liệu…</p>';
  panel.classList.remove("hidden");

  App.apiGet("get_ai_summary")
    .then(function (result) {
      App.aiSummaryLoadedFor = today;
      if (!result.available) {
        panel.classList.add("hidden");
        return;
      }
      App.aiSummaryCache = result.summary;
      panel.innerHTML = '<span class="eyebrow">Nhận xét hôm nay</span><p>' + App.esc(result.summary) + "</p>";
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

App.refreshAddForm = function () {
  var data = App.state.data;
  if (!data) return;
  var direction = App.currentDirection();

  var account = App.$("#tx-account");
  var toAccount = App.$("#tx-to-account");
  var category = App.$("#tx-category");

  var keepAccount = account.value, keepTo = toAccount.value, keepCategory = category.value;
  account.innerHTML = App.accountOptions(data.accounts, keepAccount, true);
  toAccount.innerHTML = App.accountOptions(data.accounts, keepTo, true);
  category.innerHTML = App.categoryOptions(data.categories, direction === "in" ? "income" : "expense", keepCategory);

  App.show("#tx-to-wrap", direction === "transfer");
  App.show("#tx-category-wrap", direction !== "transfer");
  App.$("#tx-account-label").textContent = direction === "transfer" ? "Từ tài khoản" : "Tài khoản";

  var dateInput = App.$("#tx-date");
  if (!dateInput.value) dateInput.value = App.today();

  App.setHtml("#add-recent", App.renderTransactionRows(data.transactions.slice(0, 5)));
};

App.updateAmountHint = function () {
  var input = App.$("#tx-amount");
  var hint = App.$("#tx-amount-hint");
  var parsed = App.tryParseAmount(input.value);
  if (parsed === null) {
    hint.textContent = input.value.trim() ? "Chưa hiểu số này — thử 500k, 1tr, 2tr5 hoặc 500000." : "";
    hint.className = "amount-hint " + (input.value.trim() ? "amount-out" : "");
  } else {
    hint.textContent = "= " + App.formatDong(parsed);
    hint.className = "amount-hint muted";
  }
};

App.submitTransaction = function () {
  var data = App.state.data;
  var direction = App.currentDirection();
  var rawAmount = App.$("#tx-amount").value.trim();
  var description = App.$("#tx-description").value.trim();
  var occurredAt = App.$("#tx-date").value;
  var parsed = App.tryParseAmount(rawAmount);

  if (!rawAmount || parsed === null || parsed <= 0) {
    App.notice("#add-message", "Nhập số tiền đã nhé — ví dụ 500k, 1tr, hoặc 500000.", "error");
    return;
  }
  if (direction === "transfer" && App.$("#tx-account").value === App.$("#tx-to-account").value) {
    App.notice("#add-message", "Chọn hai tài khoản khác nhau cho lệnh chuyển khoản.", "error");
    return;
  }

  // A big spend is worth a second thought before it's recorded, not after.
  if (direction === "out" && parsed >= 1000000) {
    if (window.confirm("Đây là khoản chi lớn (" + App.formatDong(parsed) + "). Mô phỏng tác động trước khi lưu?")) {
      App.state.planSection = "simulate";
      App.switchTab("plan");
      window.setTimeout(function () {
        var amountField = App.$("#sim-amount");
        if (amountField) {
          amountField.value = rawAmount;
          App.$("#sim-name").value = description;
        }
      }, 0);
      return;
    }
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
      App.$("#tx-amount").value = "";
      App.$("#tx-description").value = "";
      App.updateAmountHint();
      var extra = result.auto_categorised ? " Đã tự xếp danh mục theo luật của bạn." : "";
      App.notice("#add-message", "Đã lưu " + App.formatDong(result.amount || parsed) + "." + extra, "ok");
      return App.load({ quiet: true });
    })
    .catch(function (err) {
      App.notice("#add-message", App.errorText(err), "error");
    })
    .finally(function () {
      button.disabled = false;
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
    reader.onerror = function () { reject(new Error("Không đọc được file ảnh.")); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error("File này không phải ảnh hợp lệ.")); };
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

App.analyzeImage = function (file) {
  App.setHtml("#import-result", '<p class="notice notice-info">Đang đọc ảnh… việc này mất vài giây.</p>');

  App.fileToScaledBase64(file)
    .then(function (image) {
      return App.apiPost("analyze_image", { image_base64: image.base64, mime_type: image.mimeType });
    })
    .then(function (result) {
      if (!result.available) {
        App.setHtml("#import-result", '<p class="notice notice-info">' +
          (result.reason === "no_key"
            ? "Tính năng này cần GEMINI_API_KEY trong Script Properties của bảng tính. Chưa có thì cứ nhập tay ở trên."
            : "Chưa đọc được ảnh này. Thử ảnh rõ hơn, hoặc nhập tay ở trên.") + "</p>");
        return;
      }
      App.importCandidates = result.candidates;
      App.setHtml("#import-result", App.renderImportCandidates(App.state.data, result.candidates));
    })
    .catch(function (err) {
      App.setHtml("#import-result", '<p class="notice notice-error">' + App.esc(App.errorText(err)) + "</p>");
    });
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
    App.notice("#import-save-message", "Chưa chọn giao dịch nào.", "info");
    return;
  }
  App.$("#save-import").disabled = true;
  App.notice("#import-save-message", "Đang lưu…", "info");

  App.apiPost("import_transactions", { rows: rows })
    .then(function (result) {
      var parts = ["Đã lưu " + result.saved + " giao dịch."];
      if (result.skipped_duplicate) parts.push(result.skipped_duplicate + " khoản đã nhập trước đó, bỏ qua.");
      if (result.skipped_invalid) parts.push(result.skipped_invalid + " khoản không hợp lệ.");
      App.setHtml("#import-result", '<p class="notice notice-ok">' + App.esc(parts.join(" ")) + "</p>");
      App.$("#import-file").value = "";
      return App.load({ quiet: true });
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
  return data.transactions.filter(function (tx) {
    if (App.state.txFilter === "out" && (tx.direction !== "out" || tx.is_transfer)) return false;
    if (App.state.txFilter === "in" && (tx.direction !== "in" || tx.is_transfer)) return false;
    if (App.state.txFilter === "transfer" && !tx.is_transfer) return false;
    if (!query) return true;
    return [tx.description, tx.category_name, tx.account_name]
      .join(" ").toLowerCase().indexOf(query) !== -1;
  });
};

App.renderList = function () {
  var data = App.state.data;
  var filtered = App.filteredTransactions();
  var shown = filtered.slice(0, App.state.txLimit);

  var filters = [
    ["all", "Tất cả"], ["out", "Chi"], ["in", "Thu"], ["transfer", "Chuyển khoản"],
  ].map(function (pair) {
    return '<button type="button" data-filter="' + pair[0] + '" aria-pressed="' +
      (App.state.txFilter === pair[0]) + '">' + pair[1] + "</button>";
  }).join("");

  var more = filtered.length > shown.length
    ? '<button type="button" class="secondary" id="show-more">Xem thêm ' +
      Math.min(40, filtered.length - shown.length) + " giao dịch cũ hơn</button>"
    : "";

  var footnote = data.transaction_count > data.transactions.length
    ? '<p class="tiny faint">Đang hiển thị ' + data.transactions.length + " giao dịch gần nhất trong tổng số " +
      data.transaction_count + ". Tải CSV ở Cài đặt để xem toàn bộ.</p>"
    : "";

  App.setHtml("#view-list",
    '<section class="card">' +
      '<input type="text" id="tx-search" placeholder="Tìm theo mô tả, danh mục, tài khoản" value="' +
        App.esc(App.state.txQuery) + '">' +
      '<div class="filters">' + filters + "</div>" +
    "</section>" +
    '<section class="card"><div class="rows">' + App.renderTransactionRows(shown) + "</div>" +
    more + footnote + "</section>"
  );
};

App.openEditDialog = function (id) {
  var data = App.state.data;
  var tx = data.transactions.filter(function (t) { return String(t.id) === String(id); })[0];
  if (!tx) return;

  var kind = tx.direction === "in" ? "income" : "expense";
  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>Sửa giao dịch</h2>' +
    '<button type="button" class="link" data-close-dialog>Đóng</button></div>' +
    '<form id="edit-form">' +
      '<input type="hidden" name="id" value="' + App.esc(tx.id) + '">' +
      '<div class="segmented">' +
        '<input type="radio" id="edit-out" name="direction" value="out"' + (tx.direction === "out" ? " checked" : "") + '><label for="edit-out">Chi</label>' +
        '<input type="radio" id="edit-in" name="direction" value="in"' + (tx.direction === "in" ? " checked" : "") + '><label for="edit-in">Thu</label>' +
      "</div>" +
      '<label class="field"><span class="field-label">Số tiền</span>' +
      '<input type="text" inputmode="numeric" name="amount" class="amount-input" value="' + App.esc(tx.amount) + '"></label>' +
      '<label class="field"><span class="field-label">Ngày</span>' +
      '<input type="date" name="occurred_at" value="' + App.esc(App.dateOnly(tx.occurred_at)) + '"></label>' +
      '<label class="field"><span class="field-label">Tài khoản</span>' +
      "<select name=\"account_id\">" + App.accountOptions(data.accounts, tx.account_id, false) + "</select></label>" +
      '<label class="field"><span class="field-label">Danh mục</span>' +
      '<select name="category_id">' + App.categoryOptions(data.categories, kind, tx.category_id) + "</select></label>" +
      '<label class="field"><span class="field-label">Mô tả</span>' +
      '<input type="text" name="description" value="' + App.esc(tx.description || "") + '"></label>' +
      // Correcting a category is the moment the user has just told the app
      // what a description means - the cheapest possible time to offer to
      // remember it. Same "learn from correction" loop as the Flask app's
      // edit page. Only offered when the category actually changed, so it
      // never nags on an unrelated edit.
      (tx.description
        ? '<div class="notice notice-info hidden" id="learn-rule-block">' +
          '<label class="inline"><input type="checkbox" name="learn_rule" value="1" style="width:auto;min-height:0">' +
          " <span>Lần sau tự xếp vào danh mục này</span></label>" +
          '<input type="text" name="learn_pattern" value="' + App.esc(tx.description) +
          '" style="margin-top:0.5rem" aria-label="Từ khóa nhận dạng">' +
          '<p class="tiny muted">Rút gọn thành từ khóa dễ khớp hơn, ví dụ chỉ để “highlands”.</p></div>'
        : "") +
      "<button type=\"submit\">Lưu thay đổi</button>" +
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

App.PLAN_SECTIONS = [
  ["budget", "Ngân sách"],
  ["goals", "Mục tiêu"],
  ["events", "Sự kiện"],
  ["income", "Thu nhập"],
  ["recurring", "Định kỳ"],
  ["forecast", "Dự báo"],
  ["simulate", "Mô phỏng"],
];

App.renderPlan = function () {
  var data = App.state.data;
  var nav = '<div class="subnav">' + App.PLAN_SECTIONS.map(function (pair) {
    return '<button type="button" data-plan-section="' + pair[0] + '" aria-pressed="' +
      (App.state.planSection === pair[0]) + '">' + pair[1] + "</button>";
  }).join("") + "</div>";

  var body;
  if (App.state.planSection === "budget") body = App.renderBudgetPlan(data);
  else if (App.state.planSection === "goals") body = App.renderGoalsPlan(data);
  else if (App.state.planSection === "events") body = App.renderEventsPlan(data);
  else if (App.state.planSection === "income") body = App.renderIncomePlan(data);
  else if (App.state.planSection === "recurring") body = App.renderRecurringPlan(data);
  else if (App.state.planSection === "forecast") body = App.renderForecastPlan();
  else body = App.renderSimulationPlan();

  App.setHtml("#view-plan", nav + body);
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
    App.notice("#budget-message", "Có " + invalid.length + " ô số tiền chưa hợp lệ — sửa rồi lưu lại.", "error");
    return;
  }
  if (jobs.length === 0) {
    App.notice("#budget-message", "Chưa nhập hạn mức nào.", "info");
    return;
  }

  var button = App.$("#save-budgets");
  button.disabled = true;
  App.notice("#budget-message", "Đang lưu " + jobs.length + " hạn mức…", "info");

  // Sheets writes are serialised behind the script lock anyway, so these go
  // one at a time rather than racing a burst of parallel requests.
  var chain = Promise.resolve();
  jobs.forEach(function (job) {
    chain = chain.then(function () {
      return App.apiPost("set_period_budget", {
        category_id: job.category_id,
        period_id: App.state.data.period.id,
        amount: job.amount,
      });
    });
  });

  chain
    .then(function () { return App.load({ quiet: true }); })
    .then(function () { App.notice("#budget-message", "Đã lưu ngân sách.", "ok"); })
    .catch(function (err) { App.notice("#budget-message", App.errorText(err), "error"); })
    .finally(function () { if (App.$("#save-budgets")) App.$("#save-budgets").disabled = false; });
};

App.runForecast = function () {
  var includeGoals = App.$("#forecast-goals").checked;
  var useReliable = App.$("#forecast-reliable").checked;
  App.setHtml("#forecast-result", '<p class="small muted">Đang tính…</p>');

  App.apiGet("get_forecast", {
    periods_ahead: 6,
    include_goals: includeGoals ? "1" : "0",
    income_basis_reliable: useReliable ? "1" : "0",
  })
    .then(function (result) {
      if (result.periods_of_history === 0) {
        App.setHtml("#forecast-result",
          '<p class="notice notice-info">Chưa có kỳ nào hoàn tất để lấy mức trung bình. Dự báo sẽ có ý nghĩa sau khi bạn ghi hết một kỳ.</p>');
        return;
      }
      var balances = result.periods.map(function (p) { return p.projected_balance; });
      var labels = result.periods.map(function (p) { return p.period_id.slice(5) + "/" + p.period_id.slice(2, 4); });
      var rows = result.periods.map(function (p) {
        return '<div class="kv"><dt>Kỳ ' + App.esc(p.period_id) +
          (p.event_cost > 0 ? ' <span class="tiny amount-out">(sự kiện −' + App.formatCompact(p.event_cost) + ")</span>" : "") +
          "</dt><dd class=\"" + (p.projected_balance < 0 ? "amount-out" : "") + '">' +
          App.formatDong(p.projected_balance) + "</dd></div>";
      }).join("");

      App.setHtml("#forecast-result",
        App.lineChart(labels, balances) +
        '<dl class="stack-tight">' + rows + "</dl>" +
        '<p class="tiny faint">Dựa trên thu ' + App.formatCompact(result.income_per_period) + " đ" +
        (result.income_basis === "reliable" ? " (thu chắc chắn)" : " (trung bình " + result.periods_of_history + " kỳ gần nhất)") +
        " và chi " + App.formatCompact(result.avg_expense) + " đ mỗi kỳ" +
        (result.goal_contribution > 0 ? ", trừ " + App.formatCompact(result.goal_contribution) + " đ cho mục tiêu" : "") +
        (result.event_total > 0 ? ", trừ " + App.formatCompact(result.event_total) + " đ cho sự kiện đã lên kế hoạch" : "") +
        ".</p>");
    })
    .catch(function (err) {
      App.setHtml("#forecast-result", '<p class="notice notice-error">' + App.esc(App.errorText(err)) + "</p>");
    });
};

App.runSimulation = function () {
  var amount = App.tryParseAmount(App.$("#sim-amount").value);
  var maintenance = App.tryParseAmount(App.$("#sim-maintenance").value) || 0;
  if (!amount || amount <= 0) {
    App.setHtml("#simulation-result", '<p class="notice notice-error">Nhập giá món đồ trước đã.</p>');
    return;
  }
  App.simResult = App.computeScenarios(App.state.data, amount, maintenance);
  App.setHtml("#simulation-result", App.renderScenarios(App.simResult));
};

// ---------------------------------------------------------------- settings

App.renderSettingsTab = function () {
  App.setHtml("#view-settings", App.renderSettings(App.state.data));
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
    versionNode.textContent = "mã v" + (App.state.data.version || "?");
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

  node.innerHTML = '<p class="notice notice-info">Bảng tính đang chạy <b>v' + App.esc(deployed) +
    "</b>, bản mới nhất là <b>v" + App.EXPECTED_VERSION + "</b>. Mọi thứ bạn đang dùng vẫn chạy bình thường — " +
    "chỉ những tính năng mới nhất là chưa có. Muốn cập nhật thì dán lại " +
    '<code>Code.gs</code> rồi <b>Triển khai → Quản lý bản triển khai → ✏ → Phiên bản: Mới</b>.</p>';
};

App.runHealthCheck = function () {
  App.notice("#setup-message", "Đang kiểm tra…", "info");
  App.apiGet("health_check")
    .then(function (result) {
      var rows = result.checks.map(function (check) {
        var mark = check.ok ? "✓" : (check.key === "gemini" ? "○" : "✗");
        var tone = check.ok ? "muted" : (check.key === "gemini" ? "faint" : "amount-out");
        return '<div class="kv"><dt class="' + tone + '">' + mark + " " + App.esc(check.label) + "</dt>" +
          '<dd class="tiny ' + tone + '" style="font-family:var(--font-ui);font-weight:400">' +
          App.esc(check.detail || (check.ok ? "ổn" : "")) + "</dd></div>";
      }).join("");
      var headline = result.ok
        ? "Mọi thứ đã sẵn sàng."
        : "Có mục cần xử lý — xem danh sách bên dưới.";
      App.setHtml("#setup-message",
        '<p class="notice notice-' + (result.ok ? "ok" : "info") + '">' + App.esc(headline) + "</p>" +
        '<dl class="stack-tight" style="margin-top:0.5rem">' + rows + "</dl>");
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

App.downloadCsv = function () {
  App.notice("#setup-message", "Đang chuẩn bị file…", "info");
  App.apiGet("export_csv")
    .then(function (result) {
      // The BOM matters: without it Excel on Windows renders Vietnamese
      // diacritics as mojibake. Every other reader ignores it.
      var blob = new Blob(["﻿" + result.csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "so-tai-chinh-" + App.today() + ".csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      App.notice("#setup-message", "Đã tải " + result.rows + " giao dịch.", "ok");
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

App.runSetup = function (seed) {
  App.notice("#setup-message", "Đang kiểm tra bảng tính…", "info");
  App.apiPost("setup", { seed: seed ? "1" : "0" })
    .then(function (result) {
      var parts = [];
      if (result.created.length) parts.push("Đã tạo tab: " + result.created.join(", ") + ".");
      if (result.repaired.length) parts.push("Đã sửa dòng tiêu đề: " + result.repaired.join(", ") + ".");
      if (result.seeded && (result.seeded.accounts || result.seeded.categories)) {
        parts.push("Đã nạp " + result.seeded.accounts + " tài khoản và " + result.seeded.categories + " danh mục mẫu.");
      }
      if (parts.length === 0) parts.push("Bảng tính đã đầy đủ, không cần thay đổi gì.");
      App.notice("#setup-message", parts.join(" "), "ok");
      return App.load({ quiet: true });
    })
    .catch(function (err) { App.notice("#setup-message", App.errorText(err), "error"); });
};

// ----------------------------------------------------------- AI on demand

App.askAi = function (topic, context, panelSelector, buttonSelector) {
  var panel = App.$(panelSelector);
  var button = App.$(buttonSelector);
  if (button) button.disabled = true;
  panel.classList.remove("hidden");
  panel.innerHTML = '<span class="eyebrow">Gợi ý từ AI</span><p class="muted">Đang phân tích…</p>';

  App.apiGet("get_ai_advice", { topic: topic, context: JSON.stringify(context) })
    .then(function (result) {
      if (!result.available) {
        panel.innerHTML = '<span class="eyebrow">Gợi ý từ AI</span><p class="muted">' +
          (result.reason === "no_key"
            ? "Chưa gắn GEMINI_API_KEY trong Script Properties nên phần này tạm nghỉ. Mọi tính năng khác vẫn chạy bình thường."
            : "Không gọi được AI lúc này. Thử lại sau nhé.") + "</p>";
        return;
      }
      panel.innerHTML = '<span class="eyebrow">Gợi ý từ AI</span><p>' + App.esc(result.advice) + "</p>";
    })
    .catch(function (err) {
      panel.innerHTML = '<span class="eyebrow">Gợi ý từ AI</span><p class="muted">' + App.esc(App.errorText(err)) + "</p>";
    })
    .finally(function () { if (button) button.disabled = false; });
};

// ------------------------------------------------------------ event wiring

// One delegated click handler for the whole app: views are re-rendered
// wholesale, so per-element listeners would need constant rebinding.
document.addEventListener("click", function (event) {
  var target = event.target.closest("[data-tab], [data-goto], [data-plan-section], [data-filter], " +
    "[data-dismiss-alert], [data-delete-tx], [data-edit-tx], [data-hide-goal], [data-hide-recurring], " +
    "[data-delete-rule], [data-edit-account], [data-apply-suggestion], [data-period-shift], [data-close-dialog], " +
    "[data-hide-income], [data-delete-event], [data-event-to-goal], #add-event-item, #save-import, " +
    "#show-more, #save-budgets, #run-forecast, #run-simulation, #export-csv, #run-health-check, #run-setup-seed, " +
    "#reset-connection, #show-connection, #retry-load, #ai-goal-priority, #ai-simulation, " +
    "#save-connection-anyway, #device-link-btn, #copy-device-link, #theme-toggle");
  if (!target) return;

  var attr = function (name) { return target.getAttribute(name); };

  if (attr("data-tab")) { App.switchTab(attr("data-tab")); return; }

  if (attr("data-goto")) {
    var parts = attr("data-goto").split(":");
    if (parts[1]) App.state.planSection = parts[1];
    App.switchTab(parts[0]);
    return;
  }

  if (attr("data-plan-section")) { App.state.planSection = attr("data-plan-section"); App.renderPlan(); return; }
  if (attr("data-filter")) { App.state.txFilter = attr("data-filter"); App.state.txLimit = 40; App.renderList(); return; }

  // Dismissing an alert only hides it for this visit - there is no "muted"
  // state anywhere, so a condition that is still true comes back next load.
  // That's deliberate: an ongoing risk shouldn't be silenceable by a tap.
  if (attr("data-dismiss-alert")) { target.closest(".alert").remove(); return; }

  if (attr("data-delete-tx")) {
    if (!window.confirm("Xóa giao dịch này? Số dư tài khoản sẽ được tính lại.")) return;
    App.apiPost("delete_transaction", { id: attr("data-delete-tx") })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-edit-tx")) { App.openEditDialog(attr("data-edit-tx")); return; }
  if (attr("data-close-dialog")) { App.$("#tx-dialog").close(); return; }

  if (attr("data-hide-goal")) {
    if (!window.confirm("Ẩn mục tiêu này? Lịch sử vẫn được giữ, chỉ không hiển thị nữa.")) return;
    App.apiPost("deactivate_goal", { id: attr("data-hide-goal") })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-hide-recurring")) {
    if (!window.confirm("Ngừng khoản định kỳ này? Các giao dịch đã ghi vẫn giữ nguyên.")) return;
    App.apiPost("deactivate_recurring", { id: attr("data-hide-recurring") })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-delete-rule")) {
    if (!window.confirm("Xóa luật tự động phân loại này?")) return;
    App.apiPost("delete_rule", { id: attr("data-delete-rule") })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-edit-account")) { App.openAccountDialog(attr("data-edit-account")); return; }

  if (attr("data-hide-income")) {
    if (!window.confirm("Ẩn nguồn thu này? Các chỉ số sẽ tính lại mà không có nó.")) return;
    App.apiPost("deactivate_income_source", { id: attr("data-hide-income") })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
    return;
  }

  if (attr("data-delete-event")) {
    if (!window.confirm("Xóa kế hoạch sự kiện này cùng toàn bộ khoản mục của nó?")) return;
    App.apiPost("delete_event_plan", { id: attr("data-delete-event") })
      .then(function () { return App.load({ quiet: true }); })
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
    case "save-budgets": App.saveBudgets(); break;
    case "run-forecast": App.runForecast(); break;
    case "run-simulation": App.runSimulation(); break;
    case "export-csv": App.downloadCsv(); break;
    case "run-health-check": App.runHealthCheck(); break;
    case "run-setup-seed": App.runSetup(true); break;
    case "save-connection-anyway":
      App.saveConfig(App.pendingConfig);
      location.reload();
      break;
    case "device-link-btn": App.showDeviceLink(); break;
    case "copy-device-link":
      App.$("#device-link").select();
      navigator.clipboard.writeText(App.$("#device-link").value).then(function () {
        App.notice("#device-link-message", "Đã sao chép.", "ok");
      }).catch(function () {
        App.notice("#device-link-message", "Không tự sao chép được — bôi đen ô trên rồi copy tay.", "info");
      });
      break;
    case "theme-toggle": App.cycleTheme(); App.updateThemeButton(); break;
    case "retry-load": App.showLoading(); App.load(); break;
    case "save-import": App.saveImport(); break;
    case "add-event-item": App.$("#event-items").insertAdjacentHTML("beforeend", App.eventItemRow("", false)); break;
    case "show-connection": App.showConnectionForm(); break;
    case "reset-connection":
      if (window.confirm("Xóa URL và mật khẩu đã lưu trên máy này? Dữ liệu trong Google Sheet không bị ảnh hưởng.")) {
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
  }
});

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
      .then(function () {
        form.reset();
        return App.load({ quiet: true });
      })
      .then(function () { App.notice(messageSelector, successText, "ok"); })
      .catch(function (err) { App.notice(messageSelector, App.errorText(err), "error"); });
  }

  if (formId === "income-form") post("add_income_source", "#income-message", "Đã thêm nguồn thu.");
  else if (formId === "event-form") {
    event.preventDefault();
    var items = App.collectEventItems();
    if (items.length === 0) {
      App.notice("#event-message", "Thêm ít nhất một khoản mục có tên đã nhé.", "error");
      return;
    }
    App.notice("#event-message", "Đang lưu…", "info");
    App.apiPost("add_event_plan", { name: body.name, event_date: body.event_date, items: items })
      .then(function () {
        form.reset();
        return App.load({ quiet: true });
      })
      .then(function () { App.notice("#event-message", "Đã lưu kế hoạch sự kiện.", "ok"); })
      .catch(function (err) { App.notice("#event-message", App.errorText(err), "error"); });
  }
  else if (formId === "goal-form") post("add_goal", "#goal-message", "Đã tạo mục tiêu.");
  else if (formId === "recurring-form") post("add_recurring", "#recurring-message", "Đã thêm khoản định kỳ.");
  else if (formId === "account-form") post("add_account", "#account-message", "Đã thêm tài khoản.");
  else if (formId === "category-form") post("add_category", "#category-message", "Đã thêm danh mục.");
  else if (formId === "rule-form") post("add_rule", "#rule-message", "Đã thêm luật.");
  else if (formId === "edit-form") {
    event.preventDefault();
    App.notice("#edit-message", "Đang lưu…", "info");
    var learnRule = body.learn_rule === "1" && String(body.learn_pattern || "").trim() && body.category_id;
    var pattern = String(body.learn_pattern || "").trim();
    var categoryForRule = body.category_id;
    delete body.learn_rule;
    delete body.learn_pattern;

    App.apiPost("update_transaction", body)
      .then(function () {
        // Saving the rule is a follow-up, never a precondition: if it fails,
        // the edit the user actually asked for has already landed.
        if (!learnRule) return null;
        return App.apiPost("add_rule", {
          pattern: pattern, category_id: categoryForRule, priority: 10, created_from: "learned",
        }).catch(function () { return null; });
      })
      .then(function () {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true });
      })
      .catch(function (err) { App.notice("#edit-message", App.errorText(err), "error"); });
  } else if (formId === "account-edit-form") {
    event.preventDefault();
    App.notice("#account-edit-message", "Đang lưu…", "info");
    App.apiPost("update_account", body)
      .then(function () {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true });
      })
      .catch(function (err) { App.notice("#account-edit-message", App.errorText(err), "error"); });
  } else if (formId === "event-goal-form") {
    event.preventDefault();
    App.notice("#event-goal-message", "Đang tạo…", "info");
    var eventId = body.event_id;
    delete body.event_id;
    App.apiPost("add_goal", body)
      .then(function (result) {
        // Link second: if this fails the goal still exists, and the worst case
        // is the suggestion showing once more - not a lost goal.
        return App.apiPost("link_event_to_goal", { id: eventId, goal_id: result.id });
      })
      .then(function () {
        App.$("#tx-dialog").close();
        return App.load({ quiet: true });
      })
      .catch(function (err) { App.notice("#event-goal-message", App.errorText(err), "error"); });
  } else if (formId === "connection-form") {
    event.preventDefault();
    var url = body.url.trim();
    var token = body.token.trim();
    if (!url || !token) {
      App.notice("#connection-message", "Cần cả URL và mã kết nối.", "error");
      return;
    }
    if (url.indexOf("/exec") === -1) {
      App.notice("#connection-message",
        "URL phải kết thúc bằng /exec. Nếu nó kết thúc bằng /dev thì đó là bản thử nghiệm, không dùng được.", "error");
      return;
    }

    // Check the URL BEFORE saving it. Pasting a link to an older deployment
    // and only finding out from a broken screen afterwards is the exact loop
    // this avoids - a deployment answers `version` without a token, so this
    // costs nothing and needs no credentials.
    App.notice("#connection-message", "Đang kiểm tra địa chỉ…", "info");
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
        ? "Địa chỉ chưa trả lời sau 20 giây (có thể Apps Script đang khởi động nguội)."
        : (version
            ? "Địa chỉ này đang chạy v" + version + ", bản mới nhất là v" + App.EXPECTED_VERSION + "."
            : "Địa chỉ này chạy mã cũ hơn v3.4, hoặc chưa triển khai xong.");
      App.setHtml("#connection-message",
        '<p class="notice notice-info">' + App.esc(warning) +
        " Vẫn lưu được và app sẽ chạy, chỉ thiếu tính năng mới nhất." +
        '</p><button type="button" class="secondary" id="save-connection-anyway">Lưu địa chỉ này</button>');
      App.pendingConfig = { url: url, token: token };
    });
  } else if (formId === "tx-form") {
    event.preventDefault();
    App.submitTransaction();
  }
});

document.addEventListener("input", function (event) {
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
  if (event.target.name === "direction" && event.target.closest("#tx-form")) App.refreshAddForm();
  if (event.target.id === "event-template") App.resetEventItems(event.target.value);
  if (event.target.id === "import-file" && event.target.files && event.target.files[0]) {
    App.analyzeImage(event.target.files[0]);
  }

  // Recording an actual amount on an event item saves straight away - it is a
  // single number, and a separate save button for each row would be friction.
  if (event.target.hasAttribute && event.target.hasAttribute("data-event-item")) {
    var input = event.target;
    App.apiPost("update_event_item", { id: input.getAttribute("data-event-item"), actual_amount: input.value })
      .then(function () { return App.load({ quiet: true }); })
      .catch(function (err) { window.alert(App.errorText(err)); });
  }
});

// --------------------------------------------------------- account dialog

App.openAccountDialog = function (id) {
  var account = App.state.data.accounts.filter(function (a) { return String(a.id) === String(id); })[0];
  if (!account) return;

  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>Sửa tài khoản</h2>' +
    '<button type="button" class="link" data-close-dialog>Đóng</button></div>' +
    '<form id="account-edit-form">' +
      '<input type="hidden" name="id" value="' + App.esc(account.id) + '">' +
      '<label class="field"><span class="field-label">Tên</span>' +
      '<input type="text" name="name" value="' + App.esc(account.name) + '"></label>' +
      '<label class="field"><span class="field-label">Loại</span><select name="type">' +
        Object.keys(App.ACCOUNT_TYPES).map(function (key) {
          return '<option value="' + key + '"' + (key === account.type ? " selected" : "") + ">" +
            App.esc(App.ACCOUNT_TYPES[key]) + "</option>";
        }).join("") +
      "</select></label>" +
      '<label class="field"><span class="field-label">Số dư thực tế</span>' +
      '<input type="text" inputmode="numeric" name="balance" value="' + App.esc(account.balance) + '"></label>' +
      '<p class="tiny muted">Sửa số dư ở đây là để chỉnh lại cho khớp thực tế, không phải để ghi nhận thu nhập — ' +
      "khoản thu thật thì nên nhập ở tab Nhập.</p>" +
      '<label class="field"><span class="field-label">Hiển thị</span><select name="is_active">' +
        '<option value="1">Đang dùng</option><option value="0">Ẩn tài khoản này</option>' +
      "</select></label>" +
      "<button type=\"submit\">Lưu thay đổi</button>" +
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
    '<div class="dialog-head"><h2>Tạo mục tiêu cho sự kiện</h2>' +
    '<button type="button" class="link" data-close-dialog>Đóng</button></div>' +
    '<form id="event-goal-form">' +
      '<input type="hidden" name="event_id" value="' + App.esc(event.id) + '">' +
      '<label class="field"><span class="field-label">Tên mục tiêu</span>' +
      '<input type="text" name="name" value="' + App.esc(event.name) + '" required></label>' +
      '<label class="field"><span class="field-label">Cần tích lũy</span>' +
      '<input type="text" inputmode="numeric" name="target_amount" value="' + App.esc(event.remaining_total) + '" required>' +
      '<span class="tiny faint">Lấy từ phần còn phải trả của sự kiện.</span></label>' +
      '<label class="field"><span class="field-label">Hạn chót</span>' +
      '<input type="date" name="deadline" value="' + App.esc(event.event_date) + '" required></label>' +
      '<label class="field"><span class="field-label">Tài khoản tích lũy</span>' +
      "<select name=\"account_id\">" + App.accountOptions(App.state.data.accounts, null, true) + "</select></label>" +
      '<input type="hidden" name="goal_type" value="savings">' +
      '<p class="tiny muted">Chia đều ' + App.formatDong(event.remaining_total) + " cho " +
      Math.max(event.periods_until, 1) + " kỳ còn lại là khoảng " +
      App.formatDong(Math.round(event.remaining_total / Math.max(event.periods_until, 1))) + " mỗi kỳ.</p>" +
      "<button type=\"submit\">Tạo và gắn vào sự kiện</button>" +
      '<div id="event-goal-message"></div>' +
    "</form>");
  App.$("#tx-dialog").showModal();
};

App.showConnectionForm = function () {
  App.setHtml("#tx-dialog-body",
    '<div class="dialog-head"><h2>Kết nối Google Sheet</h2>' +
    '<button type="button" class="link" data-close-dialog>Đóng</button></div>' +
    '<form id="connection-form">' +
      '<label class="field"><span class="field-label">Địa chỉ bảng tính</span>' +
      '<input type="text" name="url" value="' + App.esc(App.config ? App.config.url : "") +
      '" placeholder="https://script.google.com/macros/s/…/exec" required>' +
      '<span class="tiny faint">URL từ Apps Script → Triển khai → Ứng dụng web, kết thúc bằng /exec.</span></label>' +
      '<label class="field"><span class="field-label">Mã kết nối</span>' +
      '<input type="password" name="token" value="' + App.esc(App.config ? App.config.token : "") +
      '" autocomplete="current-password" required>' +
      '<span class="tiny faint">Xem lại ở menu Sổ tài chính → ② Xem mã kết nối trên Google Sheet.</span></label>' +
      "<button type=\"submit\">Lưu và tải lại</button>" +
      '<div id="connection-message"></div>' +
    "</form>"
  );
  App.$("#tx-dialog").showModal();
};

App.THEME_LABEL = { auto: "Tự động", light: "Sáng", dark: "Tối" };

App.updateThemeButton = function () {
  var button = App.$("#theme-toggle");
  if (button) button.title = "Giao diện: " + App.THEME_LABEL[App.currentTheme()];
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
    '<div class="dialog-head"><h2>Mở sổ trên thiết bị khác</h2>' +
    '<button type="button" class="link" data-close-dialog>Đóng</button></div>' +
    '<p class="small muted">Mở đường dẫn này trên điện thoại hay máy khác là vào thẳng sổ, ' +
    "không phải gõ lại gì.</p>" +
    '<textarea id="device-link" rows="4" readonly style="font-family:var(--font-num);font-size:0.75rem">' +
    App.esc(link) + "</textarea>" +
    '<button type="button" id="copy-device-link">Sao chép đường dẫn</button>' +
    '<p class="notice notice-info">Đường dẫn này <b>chứa mã kết nối</b> — ai có nó là mở được sổ của bạn. ' +
    "Chỉ gửi cho chính mình, đừng đăng công khai hay gửi vào nhóm chat.</p>" +
    '<div id="device-link-message"></div>');
  App.$("#tx-dialog").showModal();
};

// -------------------------------------------------------------------- boot

(function boot() {
  App.config = App.loadConfig();
  App.updateThemeButton();

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
