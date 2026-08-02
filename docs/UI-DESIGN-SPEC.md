# UI Design Spec — Personal Finance App
### Bản mô tả thiết kế giao diện · lấy cảm hứng MoMo / Timo · song ngữ Vi/En

> Tài liệu này mô tả **giao diện & trải nghiệm** cho app quản lý tài chính cá nhân của bạn.
> Nó bám sát data model có thật trong `CLAUDE.md` (bản `sheet-lite v3`: Google Sheets = DB, Apps Script = API,
> frontend tĩnh không build step) — nên mọi màn hình dưới đây đều map được vào dữ liệu thật, không phải mockup suông.
> This document describes the **UI & UX** for your personal finance app, inspired by MoMo/Timo, matching the real
> `sheet-lite v3` data model. Bilingual Vietnamese/English throughout.

---

## 0. Tóm tắt 1 phút / One-minute summary

| Hạng mục | Quyết định |
|---|---|
| **Loại app** | Quản lý chi tiêu cá nhân: ghi nhận → lập kế hoạch → mô phỏng → dự báo (single-user) |
| **Nền tảng** | PWA (thêm vào màn hình chính iPhone/Android) + desktop web. Có dark mode. |
| **Ngôn ngữ** | Song ngữ Vi/En, toggle trong Cài đặt. Mặc định Vi. |
| **Điều hướng** | Bottom tab bar 5 mục (MoMo-style), route client-side |
| **Chu kỳ** | "Kỳ" 15 → 14 (cấu hình được), KHÔNG phải tháng dương lịch — đây là điểm nhận diện |
| **Màu chủ đạo** | Nền trắng/đen (light/dark) + **tím-chàm (indigo)** làm brand; màu tiền có nghĩa: chi = gạch, thu = thông, chuyển = thép, cảnh báo = hoàng thổ |
| **Chữ số** | Font monospace bảng (tabular) cho MỌI con số; chữ thường dùng font hệ thống |
| **Dữ liệu** | Gọi API (Apps Script Web App) → render số liệu thật; có trạng thái loading escalate |
| **Điểm nhấn** | "Dải kỳ" (period ribbon): 2 thanh trên cùng 1 thước — thời gian đã trôi vs tiền đã tiêu |

---

## 1. Ý tưởng sản phẩm / Product concept

App biến việc quản lý tiền từ **"ghi nhận quá khứ"** sang **"hoạch định tương lai"**. Năm trụ cột (đã build xong ở backend):

1. **Ghi nhận** — thu / chi / **chuyển khoản nội bộ** (transfer giữa các ví của chính bạn, không thổi phồng thu-chi).
2. **Ngân sách theo kỳ** (`period_budgets`) — hũ chi tiêu theo chu kỳ 15→14.
3. **Mục tiêu** (`goals`) — quỹ khẩn cấp / tiết kiệm / đầu tư / y tế / tùy chỉnh; tiến độ đọc trực tiếp từ số dư tài khoản.
4. **Mô phỏng quyết định chi** (`spending_simulations`) — "trước khi mua món lớn, xem tác động trước": trả ngay / trả góp 3-6-12 kỳ / hoãn 3-6 kỳ.
5. **Dự báo dòng tiền** (`cashflow_forecasts`) + **điểm sức khỏe tài chính** (health-score dashboard là trang chủ).

Kèm theo: **nguồn thu** (`IncomeSources`, có độ tin cậy 0–100%), **kế hoạch sự kiện** (`EventPlans` — chuyến đi, sinh nhật), **luật tự phân loại** (`Rules`), **nhập từ ảnh chụp màn hình** (OCR, chỉ bản Flask).

> **Nguyên tắc AI xuyên suốt:** AI chỉ **giải thích** số đã tính sẵn, không tự bịa số mới. AI từ chối bình luận khi sổ trống.

---

## 2. Ngôn ngữ thiết kế / Design language

### 2.1 Bảng màu / Color tokens

Định nghĩa ở 3 tầng để in-page toggle luôn thắng media query: `:root`, `@media (prefers-color-scheme: dark)`, `:root[data-theme="..."]`.

| Token | Light | Dark | Ý nghĩa |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0f1115` | Nền chính |
| `--surface` | `#f6f7f9` | `#171a21` | Nền thẻ/card |
| `--surface-2` | `#eef0f4` | `#1f232c` | Nền thẻ chìm hơn |
| `--ink` | `#0f1115` | `#f2f4f8` | Chữ chính |
| `--ink-soft` | `#5b6472` | `#98a2b3` | Chữ phụ |
| `--brand` | `#4f46e5` | `#818cf8` | **Tím-chàm** — nhận diện, nút chính. Cố tình *lùi lại* để màu tiền nổi. |
| `--brand-ink` | `#ffffff` | `#0f1115` | Chữ trên nền brand |
| `--out` (chi) | `#b4442e` | `#e07a5f` | Gạch — tiền ra |
| `--in` (thu) | `#2f6f4e` | `#6bbf8a` | Thông — tiền vào |
| `--transfer` | `#4a6b8a` | `#7fa8cf` | Thép — chuyển nội bộ |
| `--warn` | `#b8860b` | `#e0b34a` | Hoàng thổ — cảnh báo/vượt ngân sách |
| `--line` | `#e3e6eb` | `#2a2f3a` | Đường kẻ, viền |

> Bạn nêu 4 hướng màu: trắng-đen, tím-đen, xanh, cổ điển. Spec này chọn **trắng/đen + tím-chàm** làm mặc định (khớp `#007aff`/indigo trong code hiện tại), và để sẵn khả năng thêm theme "xanh" và "cổ điển" như 2 preset `data-theme` bổ sung trong Cài đặt.

### 2.2 Kiểu chữ / Typography

- **Số**: font monospace bảng (`ui-monospace`, `"SF Mono"`, `"JetBrains Mono"`) — class `.num`. Mọi số dư, số tiền, %, ngày.
- **Chữ**: font hệ thống (`-apple-system`, `Segoe UI`, `Roboto`) — phủ đủ dấu tiếng Việt, không cần tải webfont.
- Số tiền lớn (số dư) là phần **to & đậm nhất màn hình** — nguyên tắc "amount là yếu tố nổi bật nhất".

### 2.3 Thẻ / Card & bo góc

- Bo góc `16px` cho thẻ lớn, `12px` cho thẻ nhỏ, `999px` cho pill/nút tab.
- Bóng đổ nhẹ, nhiều lớp (soft shadow) thay vì viền cứng — phong cách MoMo.
- Khoảng trắng rộng rãi, vùng chạm (touch target) ≥ 44px.

### 2.4 Chuyển động / Animation

- Chuyển tab: fade + slide nhẹ 150–200ms.
- Thẻ số dư: đếm số (count-up) khi load xong.
- "Dải kỳ": thanh chạy mượt (ease-out) khi cập nhật.
- Bấm nút: scale 0.97 + haptic (nếu hỗ trợ). Không lạm dụng.

---

## 3. Khung điều hướng / Navigation shell

**Bottom tab bar cố định, 5 mục** (giống MoMo/Timo). Nút giữa nổi bật.

```
┌─────────────────────────────────────────────┐
│                                             │
│              (nội dung tab)                  │
│                                             │
├─────────────────────────────────────────────┤
│  🏠      📒      ➕      🎯       ⚙️        │
│  Nhà    Sổ    (Nhập)  Kế hoạch  Cài đặt     │
└─────────────────────────────────────────────┘
```

| # | Tab (Vi / En) | Route | Nội dung |
|---|---|---|---|
| 1 | **Nhà** / Home | `#/` | Health-score dashboard (trang đầu tiên mỗi ngày) |
| 2 | **Sổ** / Ledger | `#/tx` | Danh sách giao dịch + lọc + sửa/xóa |
| 3 | **Nhập** / Add | `#/add` | Form thêm giao dịch (nút giữa, nổi) |
| 4 | **Kế hoạch** / Plan | `#/plan` | Ngân sách · Mục tiêu · Sự kiện · Mô phỏng · Dự báo |
| 5 | **Cài đặt** / Settings | `#/settings` | Kết nối, kỳ, ngôn ngữ, theme, tài khoản/danh mục |

> **Nút "Nhập" ở giữa** = hành động thường xuyên nhất → đặt trung tâm như nút "Quét QR" của MoMo.
> Views re-render toàn bộ từ `App.state.data` qua **một** delegated listener; **riêng form Nhập không bao giờ bị re-render** (chỉ refresh `<select>`) để không xóa số đang gõ dở.

---

## 4. Chi tiết từng màn hình / Screen-by-screen

### 4.1 🏠 Nhà — Health-score Dashboard

Trang chủ = "điều đầu tiên nhìn mỗi ngày". Thứ tự đọc: **số dư → biết mình đang ở đâu → nhập giao dịch hôm nay → xem kế hoạch**.

**Bố cục từ trên xuống:**

1. **Hero — Số dư khả dụng** (thẻ lớn, gradient nhẹ theo brand)
   - Số dư ròng (tổng các tài khoản) — `.num`, cực lớn, có nút 👁 ẩn/hiện.
   - Dòng phụ: "Tiền lời hôm nay +Xđ" (nếu có), hoặc net worth vs liquid balance.
   - Điểm sức khỏe tài chính (0–100) dạng vòng tròn hoặc thanh, kèm nhãn xanh/vàng/đỏ.

2. **"Dải kỳ" (period ribbon)** — ⭐ điểm nhận diện
   ```
   Kỳ 15/07 – 14/08          Còn 6 ngày
   Thời gian ▓▓▓▓▓▓▓▓░░░░  80% đã trôi
   Đã tiêu   ▓▓▓▓▓▓░░░░░░  62% ngân sách
                    ↑ khoảng cách này = "bạn đang tiêu chậm hơn nhịp thời gian"
   ```
   Hai thanh trên cùng một thước: thời-gian-đã-trôi (trên) vs tiền-đã-tiêu (dưới). **Khoảng cách giữa 2 thanh chính là thông điệp.** Chỉ có ý nghĩa vì app tổ chức quanh chu kỳ 15→14.

3. **Grid chỉ số sức khỏe** (2×N thẻ nhỏ, MoMo-style icon grid): số ngày "sống sót" nếu mất thu nhập, tỷ lệ tiết kiệm kỳ này, burn rate vs elapsed, độ cứng chi tiêu (rigidity), 50/30/20, độ tập trung chi tiêu, thu chắc chắn (reliable income).

4. **Thẻ mục tiêu gần nhất** + **thẻ sự kiện sắp tới** — cross-check với số dư hiện tại.

5. **Thẻ AI tóm tắt hôm nay** — 1–2 câu, nút "Xem chi tiết". Nếu sổ trống → thẻ first-run ("Thêm giao dịch đầu tiên"), KHÔNG hiện lưới toàn dấu gạch.

**Trạng thái đặc biệt:**
- **Loading**: `showLoading()` vẽ ngay trước round-trip đầu; hint escalate 0s → 6s → 45s (cold start Apps Script có thể tới ~97s).
- **Fatal**: mọi lỗi render → `showFatal` (parked trong state, sống sót qua switch tab). **Không bao giờ để màn hình trắng.**
- **Sai phiên bản**: payload thiếu `period`/`money`/`health` → báo đúng lỗi "đang chạy bản Sheet cũ hơn giao diện" + 5 bước redeploy.

---

### 4.2 📒 Sổ — Danh sách giao dịch / Ledger

- **Thanh lọc pill** trên cùng: Tất cả · Chi · Thu · Chuyển · [theo danh mục] · [theo kỳ]. (Pill highlight như tab "Gần đây/Đã lưu" của MoMo — ảnh 4.)
- **Danh sách nhóm theo ngày**, mỗi dòng: icon danh mục + tên + tài khoản → số tiền (màu theo direction: `--out`/`--in`/`--transfer`).
- **Số dương luôn**, dấu thể hiện bằng màu + hướng, không bằng số âm.
- Bấm 1 dòng → mở dialog **sửa** (đổi số tiền/danh mục/tài khoản/ngày `occurred_at` — cho phép backdate). Đổi danh mục → hiện gợi ý "Lưu thành luật tự phân loại?" (learn-a-rule-on-correction).
- Nút xóa có `confirm()`.
- Xuất CSV (`actionExportCsv_`).

> **Cảnh báo kỹ thuật (đã fix, giữ nguyên):** đừng dùng `form.id` — bị shadow bởi `<input name="id">`; dùng `getAttribute("id")`. Nút lưu chỉ đi qua submit event, không nằm trong click-handler (nếu không sẽ lưu 2 lần).

---

### 4.3 ➕ Nhập — Thêm giao dịch / Add transaction

Form đơn giản, nhanh, ít ma sát nhất có thể:

1. **Bàn phím số lớn** ở trên: nhập số tiền — chấp nhận shorthand Việt (`1tr` = 1.000.000, `50k` = 50.000). Phải parse đúng, không được "sửa live" phá số đang gõ.
2. Chọn loại: **Chi / Thu / Chuyển** (3 pill lớn, đổi màu accent theo loại).
3. Chọn danh mục (grid icon), tài khoản nguồn (và tài khoản đích nếu là Chuyển).
4. Ghi chú (mô tả) — dùng để auto-phân loại qua Rules.
5. Ngày (mặc định hôm nay, cho backdate).
6. Nút **Lưu** to, màu brand.

- Nếu số tiền ≥ 1.000.000đ → hiện gợi ý mềm: "Mô phỏng tác động khoản chi này?" → link sang `#/plan/simulate`.
- Form này **không bao giờ bị re-render nền**.

---

### 4.4 🎯 Kế hoạch — Plan (hub 5 mục)

Trang hub với 5 thẻ lớn (hoặc sub-tab), mỗi thẻ vào 1 khu:

#### a) Ngân sách theo kỳ / Period budgets (`period_budgets`)
- Danh sách "hũ" theo danh mục cho kỳ hiện tại: đã tiêu / hạn mức, thanh tiến độ đổi màu (`--in` → `--warn` khi gần/vượt).
- Nút "Gợi ý hạn mức" (`suggestPeriodBudgetAmounts_`) — điền sẵn dựa lịch sử.
- Nhãn nguồn số: thủ công / gợi ý cố định / gợi ý biến đổi / AI điều chỉnh.

#### b) Mục tiêu / Goals (`goals`)
- Card từng mục tiêu: tên, loại (quỹ khẩn cấp/tiết kiệm/đầu tư/y tế/tùy chỉnh), thanh tiến độ %, còn thiếu, cần góp/kỳ, cờ "off-track"/"quá hạn".
- Tiến độ đọc **trực tiếp từ số dư tài khoản** liên kết (không có running total riêng).
- Nút tạo mục tiêu (`emergency_fund` tự gợi ý mục tiêu = 6× chi thiết yếu/kỳ).
- ≥ 2 mục tiêu → hiện nút "AI xếp ưu tiên" (`/api/ai/goal-priority`).
- "Ẩn mục tiêu" (is_active=0, giữ lịch sử) thay vì xóa.

#### c) Sự kiện / Event plans (`EventPlans`)
- Card sự kiện (chuyến đi, sinh nhật): ngày, tổng dự kiến, đã chi/còn lại.
- Tạo từ template (gợi ý **tên khoản mục, không gợi giá**) + dòng tùy chỉnh.
- Sự kiện đủ lớn (≥10tr) & đủ xa (≥2 kỳ) → gợi ý **một lần** biến thành mục tiêu, link 2 chiều.

#### d) Mô phỏng chi tiêu / Spending simulation (`spending_simulations`)
- Nhập: giá món + chi phí duy trì/kỳ + số kỳ sử dụng.
- Bảng 6 kịch bản: trả ngay · trả góp 3/6/12 kỳ · hoãn 3/6 kỳ + hàng baseline không mua.
- **Nhấn mạnh KHI nào từng kịch bản "vỡ"** (kỳ đầu tiên âm), không chỉ mức thấp nhất.
- Đèn giao thông xanh/vàng/đỏ mỗi kịch bản. Biểu đồ đường SVG tự vẽ (có/không có khoản chi).
- AI chỉ giải thích 1 câu lợi + 1 câu hại mỗi kịch bản + 1 khuyến nghị. **Đóng băng vĩnh viễn** sau lần đầu.

#### e) Dự báo dòng tiền / Cashflow forecast (`cashflow_forecasts`)
- Biểu đồ đường số dư dự phóng N kỳ tới (mô hình `project_simple_trajectory`).
- Trừ **phần chưa trả** của mỗi sự kiện đúng kỳ nó rơi vào.
- Có thể đổi cơ sở thu = thu-theo-độ-tin-cậy (reliability-weighted).
- Footnote: chỉ tính sự kiện thực sự nằm trong cửa sổ dự phóng.

---

### 4.5 ⚙️ Cài đặt — Settings

- **Kết nối**: dán URL Apps Script + token (lưu `localStorage`, ship blank). Nút "Kiểm tra" (`health_check` — checklist pass/fail từng mục). Hiện `VERSION` đang chạy.
- **Kỳ**: đổi ngày bắt đầu kỳ (mặc định 15), áp dụng cho MỌI tính toán theo kỳ.
- **Ngôn ngữ**: Vi / En.
- **Theme**: Sáng / Tối / Theo hệ thống (+ preset "xanh", "cổ điển" nếu bật).
- **Tài khoản & Danh mục**: xem/sửa cây danh mục, các ví (MoMo, ngân hàng, tiền mặt, quỹ...).
- **Nguồn thu** (`IncomeSources`): tên, số dự kiến, độ tin cậy 0–100%.
- **Luật tự phân loại** (`Rules`): danh sách mẫu → danh mục, xóa có confirm.
- **Thiết lập lại / seed** (`setupEverything` / `actionSetup_`).

---

## 5. Tích hợp API & số liệu / API & data integration

- **Backend**: Google Apps Script Web App (`Code.gs`), 1 endpoint `…/exec`, định tuyến qua action map (read/write, write có script lock).
- **Bootstrap**: 1 call `action=bootstrap` trả toàn bộ payload (period, money, health, accounts, categories, transactions, goals, events, budgets...). Frontend render từ `App.state.data`.
- **Shape-check bắt buộc** payload trước khi render; thiếu field → báo "bản cũ" + hướng dẫn redeploy, KHÔNG crash trắng.
- **`action=version`** không cần token (chẩn đoán deploy cũ) — dán thẳng vào trình duyệt được.
- **`App.parseResponse`**: đọc text trước; nếu bắt đầu bằng `<` (Apps Script trả HTML 200) → giải thích "URL sai / deployment vừa tạo đang lan truyền, đợi 1 phút".
- **AI** (Gemini): giải thích số đã tính; từ chối khi `transaction_count === 0`; cache theo task; khuyến nghị mô phỏng đóng băng sau lần đầu. Flash-tier cho tóm tắt, heavy-tier cho phân tích mô phỏng/dự báo.

**Biểu đồ**: SVG tự vẽ inline (`sparkline`, `lineChart`) — không CDN, giữ đúng tinh thần "trang không phụ thuộc gì".

---

## 6. Song ngữ / Bilingual (Vi ↔ En)

- Toàn bộ chuỗi UI để trong 1 bảng `i18n` (`{ vi: {...}, en: {...} }`), key phẳng.
- Toggle trong Cài đặt, lưu `localStorage`, đổi tức thì không reload.
- **Con số & tiền tệ**: luôn định dạng VND (`3.266.701đ`) bất kể ngôn ngữ; ngày theo locale.
- Thuật ngữ giữ nhất quán: "kỳ/period", "hũ/budget", "mục tiêu/goal", "chuyển/transfer".

---

## 7. Bộ tài sản hình ảnh cần chuẩn bị / Assets checklist

| Asset | Ghi chú |
|---|---|
| **Logo** | Bạn gửi ảnh "FINANCE" (chữ đen, mũi tên tăng trưởng ở chữ A) — dùng làm hướng wordmark. Nên có thêm bản mono trắng cho dark mode. |
| **App icon** | 180×180 (apple-touch), 192, 512, favicon 32. Hiện là ô vuông + glyph "đ" trắng — có thể thay bằng mũi tên FINANCE. |
| **Icon danh mục** | Bộ icon line/duotone cho ăn uống, đi lại, hóa đơn, giải trí... (phong cách như grid MoMo ảnh 6–7). |
| **Icon loại tiền** | 3 màu ngữ nghĩa: chi/thu/chuyển. |
| **Minh họa trạng thái rỗng** | First-run card, sổ trống, chưa có mục tiêu. |
| **manifest.json** | name, theme-color (brand), `display: standalone`, icons. |

> Ảnh "finance chalkboard" (ảnh 9) hợp làm moodboard/nền onboarding, không nên đưa vào UI chính (quá rối so với phong cách tối giản).

---

## 8. Nguyên tắc bất biến / Invariants (đừng phá)

1. Số dư = con số to & đậm nhất mỗi màn hình liên quan tiền.
2. Mọi con số dùng `.num` (monospace bảng); brand màu **lùi**, để màu tiền nổi.
3. Chu kỳ 15→14, KHÔNG phải tháng dương lịch — "dải kỳ" là chữ ký của app.
4. Form Nhập không bao giờ bị re-render nền.
5. Không bao giờ để màn hình trắng khi lỗi — luôn `showFatal` có thông điệp hành động được.
6. AI chỉ giải thích số đã tính, không bịa số; từ chối khi sổ trống.
7. Số tiền luôn dương + direction mang dấu; chuyển nội bộ không thổi phồng thu/chi.
8. Hai design system (dashboard/kế hoạch dùng hệ mới; các trang cũ dùng `BASE_STYLE`) — chỉ migrate khi được yêu cầu rõ ràng, từng bước.

---

## 9. Việc tiếp theo gợi ý / Suggested next steps

1. Chốt **theme mặc định** (trắng+tím-chàm) và 2 preset phụ (xanh, cổ điển).
2. Vẽ **wireframe 5 tab** ở Figma/Claude Design từ spec này.
3. Dựng **design tokens** (`assets/app.css`) trước, rồi từng view.
4. Ưu tiên hoàn thiện **Nhà (dashboard)** + **Nhập** trước — 2 màn dùng mỗi ngày.
5. Chuẩn bị **bộ icon danh mục** + **app icon** từ wordmark FINANCE.

---

*File này là spec sống — cập nhật khi thêm/đổi tính năng. Map 1-1 với `CLAUDE.md` và `sheet-lite/README.md`.*
