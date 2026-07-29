# Sổ tài chính — bản Sheet-lite

Một bản **song song, tách biệt hoàn toàn** với app Flask+SQLite chính trong repo này (thư mục `src/`). Bản này:

- Dùng **Google Sheets** làm database — phù hợp vì chỉ dùng cho 1 người.
- Dùng **Google Apps Script** (deploy dạng Web App) làm lớp API mỏng đứng giữa — vì 1 file HTML tĩnh không thể ghi thẳng vào Sheet một cách an toàn.
- Là **1 file HTML tĩnh** (`index.html`), không cần build, không cần server chạy nền — mở trực tiếp trong trình duyệt hoặc host miễn phí trên GitHub Pages.
- Dùng **cùng mô hình dữ liệu** (accounts / categories / transactions, `amount` luôn dương + `direction` mang dấu, chuyển khoản gắn danh mục `kind=transfer` thay vì thêm 1 direction thứ 3) như app chính — để sau này phát triển thêm (ngân sách, mục tiêu...) không phải làm lại từ đầu.

**Phạm vi v1 (cố ý gọn để phát triển dần)**: tài khoản, danh mục, ghi/xem/xóa giao dịch, chuyển khoản giữa tài khoản, số dư, tổng thu/chi tháng này. Chưa có: AI, dự báo dòng tiền, mục tiêu, ngân sách theo kỳ, nhập ảnh OCR — những tính năng này có sẵn đầy đủ ở app Flask chính, thêm vào bản Sheet-lite này là việc của các lần sau.

## Thiết lập (làm 1 lần)

### 1. Tạo Google Sheet

Tạo 1 Google Sheet mới, tạo đúng 3 tab với tên **chính xác** như sau (viết hoa/thường đúng):

**Tab `Accounts`** — dòng đầu tiên (header) là:
```
id	name	type	balance	is_active
```

**Tab `Categories`** — header:
```
id	name	kind	parent_id
```
`kind` phải là `expense`, `income`, hoặc `transfer`. Thêm ít nhất 1 dòng `kind=transfer` (ví dụ `name=Chuyển khoản nội bộ`) — tính năng chuyển khoản cần dòng này để gắn danh mục.

**Tab `Transactions`** — header:
```
id	occurred_at	amount	direction	account_id	category_id	description	source
```

Sau khi tạo header, thêm sẵn vài dòng tài khoản/danh mục ban đầu (id tự đặt tăng dần từ 1) — ví dụ:
- Accounts: `1, Tiền mặt, cash, 0, TRUE`
- Categories: `1, Ăn uống, expense,` / `2, Lương, income,` / `3, Chuyển khoản nội bộ, transfer,`

### 2. Tạo Apps Script

Trong Sheet vừa tạo: **Tiện ích mở rộng (Extensions) > Apps Script**. Xóa nội dung mặc định, dán toàn bộ nội dung file [`apps-script/Code.gs`](apps-script/Code.gs) vào.

**Đặt đúng múi giờ**: Project Settings (biểu tượng bánh răng bên trái) → Time zone → chọn `(GMT+07:00) Vietnam Time` — nếu để mặc định (thường là múi giờ Mỹ), "tổng thu/chi tháng này" sẽ tính sai ranh giới ngày/tháng.

**Đặt token (mật khẩu chia sẻ)**: Project Settings → Script Properties → Add script property:
- Property: `APP_TOKEN`
- Value: tự đặt 1 chuỗi bất kỳ, coi như mật khẩu (giống `APP_PASSWORD` của app Flask chính) — không cần phức tạp vì chỉ bạn dùng, nhưng đừng để trống.

### 3. Deploy Web App

Trong trình soạn thảo Apps Script: **Deploy > New deployment**. Chọn loại **Web app**. Cấu hình:
- Execute as: **Me**
- Who has access: **Anyone with the link**

Bấm Deploy, cấp quyền khi được hỏi (đây là script của chính bạn, chạy trên Sheet của chính bạn). Copy **URL** hiện ra (dạng `https://script.google.com/macros/s/AKfycb.../exec`).

**Lưu ý khi sửa code sau này**: mỗi lần sửa `Code.gs`, phải tạo **New deployment** mới (hoặc "Manage deployments" → sửa deployment hiện có) để URL đang dùng nhận code mới — Apps Script không tự áp dụng thay đổi vào deployment cũ.

### 4. Mở `index.html`

Mở file [`index.html`](index.html) trực tiếp trong trình duyệt (double-click, hoặc host lên GitHub Pages). Lần đầu mở sẽ hỏi URL Web App + token — dán vào, bấm "Lưu và bắt đầu". Trình duyệt sẽ nhớ 2 thông tin này (qua `localStorage`), không cần nhập lại các lần sau (trừ khi đổi trình duyệt/máy khác).

## Đưa lên GitHub Pages (tùy chọn)

Repo này đã có sẵn trên GitHub. Vào **Settings → Pages** của repo, chọn build từ nhánh `main`, thư mục `/sheet-lite` (hoặc `/` rồi vào `sheet-lite/index.html`) — sau đó trang sẽ có URL công khai dạng `https://<username>.github.io/quan-ly-tai-chinh/sheet-lite/`. Vì mọi dữ liệu thật nằm trong Google Sheet (không nằm trong file HTML), việc trang HTML công khai không tự làm lộ dữ liệu — nhưng **token** (mật khẩu Apps Script) vẫn phải giữ kín, ai có token mới gọi được API ghi dữ liệu.

## Kiểm thử `Code.gs`

`apps-script/test/test_code.js` chạy được bằng Node thường (`node sheet-lite/apps-script/test/test_code.js`), không cần Sheet/deployment thật — nó giả lập `SpreadsheetApp`/`PropertiesService`/`LockService`/... bằng mảng JS thuần rồi gọi thẳng các hàm trong `Code.gs`. Chạy lại sau mỗi lần sửa `Code.gs`, đặc biệt phần tính tiền (`parseAmountVnd_`) và cập nhật số dư.

## Vì sao POST gửi `Content-Type: text/plain`, không phải `application/json`?

Apps Script Web App không xử lý được preflight request (`OPTIONS`) mà trình duyệt tự gửi trước một request `POST` có `Content-Type: application/json`. Gửi bằng `text/plain` tránh được preflight (CORS coi đây là "simple request"), còn phía `Code.gs` vẫn `JSON.parse()` được nội dung gửi lên bất kể `Content-Type` khai báo là gì. Đây là cách làm chuẩn khi dùng Apps Script làm API cho 1 trang tĩnh — đừng đổi lại `application/json` nếu không sẽ gặp lỗi CORS im lặng (request bị chặn, không có thông báo lỗi rõ ràng trong `fetch()`).
