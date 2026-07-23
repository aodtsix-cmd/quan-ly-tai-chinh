from datetime import datetime

from flask import Flask, jsonify, render_template_string, request

from transaction import connect_db

app = Flask(__name__)


def build_category_tree(cursor, kind):
    """Return top-level categories of `kind`, each with its children (if any)."""
    cursor.execute(
        """SELECT id, name_vi, parent_id FROM categories
           WHERE kind = ? ORDER BY parent_id IS NOT NULL, parent_id, id""",
        (kind,),
    )
    rows = cursor.fetchall()

    parents = []
    children_by_parent = {}
    for row in rows:
        if row["parent_id"] is None:
            parents.append({"id": row["id"], "name": row["name_vi"], "children": []})
        else:
            children_by_parent.setdefault(row["parent_id"], []).append(
                {"id": row["id"], "name": row["name_vi"]}
            )

    for parent in parents:
        parent["children"] = children_by_parent.get(parent["id"], [])

    return parents


def get_accounts(cursor):
    cursor.execute(
        "SELECT id, name, current_balance FROM accounts WHERE is_active = 1 ORDER BY id"
    )
    return [
        {"id": row["id"], "name": row["name"], "balance": row["current_balance"]}
        for row in cursor.fetchall()
    ]


@app.route("/")
def index():
    conn = connect_db()
    cursor = conn.cursor()
    accounts = get_accounts(cursor)
    categories_by_kind = {
        "expense": build_category_tree(cursor, "expense"),
        "income": build_category_tree(cursor, "income"),
    }
    conn.close()
    return render_template_string(
        PAGE_TEMPLATE, accounts=accounts, categories_by_kind=categories_by_kind
    )


@app.route("/api/transactions", methods=["POST"])
def create_transaction():
    data = request.get_json(silent=True) or {}

    direction = data.get("direction")
    if direction not in ("in", "out"):
        return jsonify(ok=False, message="Loại giao dịch không hợp lệ."), 400

    try:
        account_id = int(data.get("account_id"))
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Vui lòng chọn tài khoản."), 400

    category_id_raw = data.get("category_id")
    category_id = int(category_id_raw) if category_id_raw not in (None, "") else None

    try:
        amount = int(data.get("amount"))
        if amount <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Số tiền không hợp lệ."), 400

    description = (data.get("description") or "").strip()

    conn = connect_db()
    cursor = conn.cursor()

    cursor.execute("SELECT 1 FROM accounts WHERE id = ? AND is_active = 1", (account_id,))
    if cursor.fetchone() is None:
        conn.close()
        return jsonify(ok=False, message="Tài khoản không hợp lệ."), 400

    if category_id is not None:
        cursor.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify(ok=False, message="Danh mục không hợp lệ."), 400

    occurred_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute(
        """INSERT INTO transactions
           (occurred_at, amount, direction, account_id, category_id,
            description, source, is_reviewed)
           VALUES (?, ?, ?, ?, ?, ?, 'manual', 1)""",
        (occurred_at, amount, direction, account_id, category_id, description),
    )

    # Same balance-update rule as transaction.py's add_transaction()
    balance_delta = amount if direction == "in" else -amount
    cursor.execute(
        "UPDATE accounts SET current_balance = current_balance + ? WHERE id = ?",
        (balance_delta, account_id),
    )

    conn.commit()
    conn.close()

    return jsonify(ok=True, message=f"Đã ghi nhận giao dịch: {amount:,} đ")


PAGE_TEMPLATE = """<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Sổ tài chính</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f5f7;
    color: #1c1c1e;
  }
  .card {
    max-width: 480px;
    margin: 0 auto;
    background: #fff;
    border-radius: 14px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 16px;
    text-align: center;
  }
  label.field-label {
    display: block;
    font-size: 0.9rem;
    color: #555;
    margin: 16px 0 6px;
  }
  select, input[type="text"] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid #d1d1d6;
    border-radius: 10px;
    background: #fff;
  }
  .segmented {
    display: flex;
    gap: 8px;
  }
  .segmented input { display: none; }
  .segmented label {
    flex: 1;
    text-align: center;
    padding: 14px 0;
    border-radius: 10px;
    border: 1px solid #d1d1d6;
    font-weight: 600;
    font-size: 1rem;
    user-select: none;
  }
  #dir-out:checked + label { background: #ff3b30; color: #fff; border-color: #ff3b30; }
  #dir-in:checked + label { background: #34c759; color: #fff; border-color: #34c759; }
  button#save {
    width: 100%;
    margin-top: 22px;
    padding: 16px;
    font-size: 1.05rem;
    font-weight: 600;
    color: #fff;
    background: #007aff;
    border: none;
    border-radius: 12px;
  }
  button#save:disabled { opacity: 0.5; }
  #message {
    margin-top: 14px;
    padding: 12px;
    border-radius: 10px;
    font-size: 0.95rem;
    text-align: center;
    display: none;
  }
  #message.ok { display: block; background: #e6f9ea; color: #1e7a34; }
  #message.error { display: block; background: #fdecea; color: #c0392b; }
</style>
</head>
<body>
<div class="card">
  <h1>Thêm giao dịch</h1>
  <form id="tx-form">
    <div class="segmented">
      <input type="radio" id="dir-out" name="direction" value="out" checked>
      <label for="dir-out">Chi tiền</label>
      <input type="radio" id="dir-in" name="direction" value="in">
      <label for="dir-in">Thu tiền</label>
    </div>

    <label class="field-label" for="account">Tài khoản</label>
    <select id="account" required></select>

    <label class="field-label" for="category">Danh mục</label>
    <select id="category"></select>

    <label class="field-label" for="amount">Số tiền (đ)</label>
    <input type="text" inputmode="numeric" id="amount" placeholder="0" required>

    <label class="field-label" for="description">Mô tả</label>
    <input type="text" id="description" placeholder="VD: Ăn trưa Highlands">

    <button type="submit" id="save">Lưu</button>
    <div id="message"></div>
  </form>
</div>

<script>
  const accounts = {{ accounts|tojson }};
  const categoriesByKind = {{ categories_by_kind|tojson }};

  const accountSelect = document.getElementById("account");
  const categorySelect = document.getElementById("category");
  const amountInput = document.getElementById("amount");
  const descriptionInput = document.getElementById("description");
  const form = document.getElementById("tx-form");
  const saveBtn = document.getElementById("save");
  const message = document.getElementById("message");
  let messageTimer = null;

  function formatVND(n) {
    return new Intl.NumberFormat("vi-VN").format(n);
  }

  function renderAccounts() {
    accountSelect.innerHTML = "";
    for (const acc of accounts) {
      const opt = document.createElement("option");
      opt.value = acc.id;
      opt.textContent = `${acc.name} (${formatVND(acc.balance)} đ)`;
      accountSelect.appendChild(opt);
    }
  }

  function renderCategories(kind) {
    categorySelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Chưa phân loại --";
    categorySelect.appendChild(placeholder);

    for (const parent of categoriesByKind[kind]) {
      if (parent.children.length === 0) {
        const opt = document.createElement("option");
        opt.value = parent.id;
        opt.textContent = parent.name;
        categorySelect.appendChild(opt);
      } else {
        const group = document.createElement("optgroup");
        group.label = parent.name;
        for (const child of parent.children) {
          const opt = document.createElement("option");
          opt.value = child.id;
          opt.textContent = child.name;
          group.appendChild(opt);
        }
        categorySelect.appendChild(group);
      }
    }
  }

  function currentKind() {
    return document.querySelector('input[name="direction"]:checked').value === "out"
      ? "expense"
      : "income";
  }

  document.querySelectorAll('input[name="direction"]').forEach((el) => {
    el.addEventListener("change", () => renderCategories(currentKind()));
  });

  amountInput.addEventListener("input", () => {
    const digits = amountInput.value.replace(/\\D/g, "");
    amountInput.value = digits ? formatVND(Number(digits)) : "";
  });

  function showMessage(text, ok) {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.className = ok ? "ok" : "error";
    messageTimer = setTimeout(() => { message.className = ""; }, 4000);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const direction = document.querySelector('input[name="direction"]:checked').value;
    const amount = parseInt(amountInput.value.replace(/\\D/g, ""), 10);

    if (!amount || amount <= 0) {
      showMessage("Vui lòng nhập số tiền hợp lệ.", false);
      return;
    }

    saveBtn.disabled = true;
    try {
      const resp = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction: direction,
          account_id: accountSelect.value,
          category_id: categorySelect.value,
          amount: amount,
          description: descriptionInput.value,
        }),
      });
      const data = await resp.json();
      showMessage(data.message, data.ok);
      if (data.ok) {
        amountInput.value = "";
        descriptionInput.value = "";
        amountInput.focus();
      }
    } catch (err) {
      showMessage("Không kết nối được với máy chủ.", false);
    } finally {
      saveBtn.disabled = false;
    }
  });

  renderAccounts();
  renderCategories(currentKind());
</script>
</body>
</html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
