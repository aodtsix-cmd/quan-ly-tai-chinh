# Sổ tài chính — bản Sheet-lite

Một bản **song song, tách biệt hoàn toàn** với app Flask+SQLite chính trong repo này (thư mục `src/`). Bản này:

- Dùng **Google Sheets** làm database — phù hợp vì chỉ dùng cho 1 người.
- Dùng **Google Apps Script** (deploy dạng Web App) làm lớp API mỏng đứng giữa — vì 1 file HTML tĩnh không thể ghi thẳng vào Sheet một cách an toàn.
- Là **1 file HTML tĩnh** (`index.html`), không cần build, không cần server chạy nền — mở trực tiếp trong trình duyệt hoặc host miễn phí trên GitHub Pages.
- Dùng **cùng mô hình dữ liệu** (accounts / categories / transactions, `amount` luôn dương + `direction` mang dấu, chuyển khoản gắn danh mục `kind=transfer` thay vì thêm 1 direction thứ 3) như app chính — để sau này phát triển thêm (ngân sách, mục tiêu...) không phải làm lại từ đầu.

**v1 (phạm vi gốc)**: tài khoản, danh mục, ghi/xem/xóa giao dịch, chuyển khoản giữa tài khoản, số dư, tổng thu/chi tháng này.

**v2 (bổ sung)**: cảnh báo rủi ro (thanh khoản, số kỳ cầm cự, dự báo cuối kỳ), ngân sách theo kỳ (đặt hạn mức theo danh mục), mục tiêu tài chính (tích lũy, theo dõi tiến độ), dự báo dòng tiền đơn giản (ngoại suy thu/chi trung bình), và 1 nhận xét bằng AI (Gemini) mỗi lần mở trang. Vẫn cố ý đơn giản hơn app Flask chính — dự báo chưa tính khoản định kỳ/mùa vụ, ngân sách chưa có gợi ý công thức, chưa có nhập ảnh OCR. Xem chú thích ngay trong `Code.gs` để biết chỗ nào bị cắt gọn và vì sao.

## Thiết lập (làm 1 lần)

### 1. Tạo Google Sheet

Tạo 1 Google Sheet mới, tạo đúng 5 tab với tên **chính xác** như sau (viết hoa/thường đúng):

**Tab `Accounts`** — dòng đầu tiên (header) là:
```
id	name	type	balance	is_active
```

**Tab `Categories`** — header:
```
id	name	kind	parent_id	necessity	stability
```
`kind` phải là `expense`, `income`, hoặc `transfer`. Thêm ít nhất 1 dòng `kind=transfer` (ví dụ `name=Chuyển khoản nội bộ`) — tính năng chuyển khoản cần dòng này để gắn danh mục. `necessity` chỉ áp dụng cho danh mục `expense`, để trống hoặc `essential`/`optional` — đặt `essential` cho các danh mục chi tiêu bắt buộc (tiền nhà, ăn uống cơ bản...), tính năng **Cảnh báo rủi ro** cần cột này mới hoạt động. `stability` để trống cũng được (chưa dùng ở v2).

**Tab `Transactions`** — header:
```
id	occurred_at	amount	direction	account_id	category_id	description	source
```

**Tab `PeriodBudgets`** (mới ở v2) — header:
```
id	category_id	period_id	amount
```
Để trống, không cần nhập gì thêm — trang web sẽ tự ghi vào khi bạn đặt ngân sách.

**Tab `Goals`** (mới ở v2) — header:
```
id	name	goal_type	target_amount	deadline	account_id	created_at	is_active
```
Cũng để trống — trang web tự ghi khi bạn tạo mục tiêu.

Sau khi tạo header, thêm sẵn vài dòng tài khoản/danh mục ban đầu (id tự đặt tăng dần từ 1) — ví dụ:
- Accounts: `1, Tiền mặt, cash, 0, TRUE`
- Categories: `1, Ăn uống, expense, , essential,` / `2, Lương, income,,,` / `3, Chuyển khoản nội bộ, transfer,,,`

### 2. Tạo Apps Script

Trong Sheet vừa tạo: **Tiện ích mở rộng (Extensions) > Apps Script**. Xóa nội dung mặc định, dán toàn bộ nội dung file [`apps-script/Code.gs`](apps-script/Code.gs) vào.

**Đặt đúng múi giờ**: Project Settings (biểu tượng bánh răng bên trái) → Time zone → chọn `(GMT+07:00) Vietnam Time` — nếu để mặc định (thường là múi giờ Mỹ), "tổng thu/chi tháng này" sẽ tính sai ranh giới ngày/tháng.

**Đặt token (mật khẩu chia sẻ)**: Project Settings → Script Properties → Add script property:
- Property: `APP_TOKEN` (bắt buộc)
- Value: tự đặt 1 chuỗi bất kỳ, coi như mật khẩu (giống `APP_PASSWORD` của app Flask chính) — không cần phức tạp vì chỉ bạn dùng, nhưng đừng để trống.

Thêm 2 script property khác nếu muốn (cả 2 đều tùy chọn, để trống vẫn chạy bình thường với giá trị mặc định):
- `PERIOD_START_DAY` — ngày bắt đầu "kỳ tài chính" mỗi tháng (mặc định `15`, giống app Flask chính — kỳ chạy từ ngày 15 tháng này tới ngày 14 tháng sau).
- `GEMINI_API_KEY` — chỉ cần nếu muốn dùng tính năng nhận xét bằng AI. Lấy miễn phí tại [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Không đặt thì mọi tính năng khác vẫn chạy bình thường, chỉ riêng khung "AI" sẽ không hiện.

### 3. Deploy Web App

Trong trình soạn thảo Apps Script: **Deploy > New deployment**. Chọn loại **Web app**. Cấu hình:
- Execute as: **Me**
- Who has access: **Anyone with the link**

Bấm Deploy, cấp quyền khi được hỏi (đây là script của chính bạn, chạy trên Sheet của chính bạn). Copy **URL** hiện ra (dạng `https://script.google.com/macros/s/AKfycb.../exec`).

**Lưu ý khi sửa code sau này**: mỗi lần sửa `Code.gs`, phải tạo **New deployment** mới (hoặc "Manage deployments" → sửa deployment hiện có) để URL đang dùng nhận code mới — Apps Script không tự áp dụng thay đổi vào deployment cũ.

### 4. Mở `index.html`

Mở file [`index.html`](index.html) trực tiếp trong trình duyệt (double-click, hoặc host lên GitHub Pages). Lần đầu mở sẽ hỏi URL Web App + token — dán vào, bấm "Lưu và bắt đầu". Trình duyệt sẽ nhớ 2 thông tin này (qua `localStorage`), không cần nhập lại các lần sau (trừ khi đổi trình duyệt/máy khác).

## Đã dùng bản v1 rồi, giờ nâng cấp lên v2 thế nào?

Nếu Sheet của bạn đã có sẵn 3 tab cũ (`Accounts`/`Categories`/`Transactions`) và đang hoạt động, làm theo đúng thứ tự sau — **đừng bỏ qua bước 1 và 2**, vì `Code.gs` mới đọc thẳng vào 2 tab mới mỗi khi tải trang:

1. Vào Sheet, tạo thêm 2 tab mới đúng tên: `PeriodBudgets` và `Goals`, với header đúng như mô tả ở Bước 1 phía trên (để trống bên dưới header, không cần nhập gì).
2. Vào tab `Categories`, thêm 2 cột mới ở cuối (cột E và F): `necessity` và `stability`. Với các danh mục chi tiêu quan trọng (tiền nhà, ăn uống...), điền `essential` vào cột `necessity` — tính năng Cảnh báo rủi ro cần dữ liệu này mới tính được. Các dòng danh mục cũ để trống 2 cột này vẫn không lỗi gì, chỉ là chưa được tính vào cảnh báo.
3. Vào Apps Script, dán đè toàn bộ nội dung `Code.gs` mới nhất (từ GitHub) vào, lưu lại.
4. **Deploy → Manage deployments** → bấm bút chì cạnh bản đang dùng → **New version** → Deploy. Link cũ vẫn dùng được, không cần đổi.
5. (Tùy chọn) Đặt thêm `GEMINI_API_KEY` nếu muốn dùng khung nhận xét AI, và `PERIOD_START_DAY` nếu muốn đổi ngày bắt đầu kỳ khác 15.
6. Mở lại trang web — mọi thứ cũ (tài khoản, giao dịch) vẫn nguyên, các khung mới (Cảnh báo, Sức khỏe tài chính, Ngân sách, Mục tiêu, Dự báo, AI) sẽ xuất hiện thêm.

**Nếu quên bước 1**: trang vẫn chạy bình thường (không vỡ) — `Code.gs` tự nhận ra tab chưa có và coi như chưa có ngân sách/mục tiêu nào, chỉ là 2 tính năng đó chưa dùng được cho tới khi bạn tạo tab.

## Đưa lên GitHub Pages (tùy chọn)

Repo này đã có sẵn trên GitHub. Vào **Settings → Pages** của repo, chọn build từ nhánh `main`, thư mục `/sheet-lite` (hoặc `/` rồi vào `sheet-lite/index.html`) — sau đó trang sẽ có URL công khai dạng `https://<username>.github.io/quan-ly-tai-chinh/sheet-lite/`. Vì mọi dữ liệu thật nằm trong Google Sheet (không nằm trong file HTML), việc trang HTML công khai không tự làm lộ dữ liệu — nhưng **token** (mật khẩu Apps Script) vẫn phải giữ kín, ai có token mới gọi được API ghi dữ liệu.

## Kiểm thử `Code.gs`

`apps-script/test/test_code.js` chạy được bằng Node thường (`node sheet-lite/apps-script/test/test_code.js`), không cần Sheet/deployment thật — nó giả lập `SpreadsheetApp`/`PropertiesService`/`LockService`/... bằng mảng JS thuần rồi gọi thẳng các hàm trong `Code.gs`. Chạy lại sau mỗi lần sửa `Code.gs`, đặc biệt phần tính tiền (`parseAmountVnd_`) và cập nhật số dư.

## Vì sao POST gửi `Content-Type: text/plain`, không phải `application/json`?

Apps Script Web App không xử lý được preflight request (`OPTIONS`) mà trình duyệt tự gửi trước một request `POST` có `Content-Type: application/json`. Gửi bằng `text/plain` tránh được preflight (CORS coi đây là "simple request"), còn phía `Code.gs` vẫn `JSON.parse()` được nội dung gửi lên bất kể `Content-Type` khai báo là gì. Đây là cách làm chuẩn khi dùng Apps Script làm API cho 1 trang tĩnh — đừng đổi lại `application/json` nếu không sẽ gặp lỗi CORS im lặng (request bị chặn, không có thông báo lỗi rõ ràng trong `fetch()`).
