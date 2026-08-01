# Sổ tài chính — bản Sheet-lite

Sổ tài chính cá nhân chạy hoàn toàn trên **Google Sheets** (làm cơ sở dữ liệu) +
**Google Apps Script** (làm API) + **một trang HTML tĩnh** (làm giao diện).
Không cần máy chủ, không cần cài đặt gì, không có bước build. Đưa lên GitHub
Pages là dùng được từ điện thoại.

Dữ liệu tài chính nằm trong bảng tính Google của chính bạn. Trang web chỉ là
giao diện — nó không lưu gì ngoài địa chỉ kết nối trong trình duyệt máy bạn.

**Bản đang chạy:** https://aodtsix-cmd.github.io/quan-ly-tai-chinh/sheet-lite/

---

## Cài đặt lần đầu (khoảng 10 phút)

### 1. Tạo bảng tính

Tạo một Google Sheet mới. Không cần tạo tab nào bằng tay — bước 5 sẽ tự tạo.

### 2. Dán mã Apps Script

Trong bảng tính: **Tiện ích mở rộng → Apps Script**. Xóa hết nội dung mẫu, dán
toàn bộ nội dung file [`apps-script/Code.gs`](apps-script/Code.gs) vào. Lưu lại.

### 3. Đặt Script Properties

Trong Apps Script: **Cài đặt dự án (⚙) → Thuộc tính tập lệnh → Thêm thuộc tính**.

| Khóa | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `APP_TOKEN` | ✅ | Mật khẩu dùng chung. Đặt gì cũng được, miễn khó đoán. |
| `PERIOD_START_DAY` | — | Ngày bắt đầu "kỳ tài chính". Mặc định `15`. |
| `GEMINI_API_KEY` | — | Chỉ cần cho phần nhận xét AI. Lấy miễn phí ở [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |

Cũng ở trang này, đặt **Múi giờ** thành `(GMT+07:00) Vietnam Time`.

### 4. Triển khai Web App

**Triển khai → Bản triển khai mới → chọn loại "Ứng dụng web"**:

- Thực thi với tư cách: **Tôi**
- Ai có quyền truy cập: **Bất kỳ ai có đường liên kết**

Bấm Triển khai, cấp quyền, rồi **copy URL** (dạng
`https://script.google.com/macros/s/…/exec`).

> Cần chọn "Bất kỳ ai có đường liên kết" thì trang HTML mới gọi được. Script vẫn
> chạy dưới quyền của bạn và vẫn chặn mọi request không có đúng `APP_TOKEN`.

### 5. Mở trang và nối vào

Mở [`index.html`](index.html) (trên GitHub Pages, hoặc mở thẳng file trên máy).
Dán URL ở bước 4 và `APP_TOKEN` ở bước 3 vào, bấm **Bắt đầu**.

Rồi vào tab **Cài đặt → Tạo + nạp danh mục mẫu**. Nút này tạo đủ 7 tab trong
bảng tính và nạp sẵn bộ tài khoản + cây danh mục tiếng Việt (giống app Flask
gốc). Xong — bắt đầu ghi giao dịch được rồi.

### 6. (Tùy chọn) Thêm vào màn hình chính iPhone

Mở trang bằng Safari → nút Chia sẻ → **Thêm vào MH chính**. Nó sẽ chạy như một
app riêng, có icon, không thanh địa chỉ.

---

## Có gì trong này

| Tab | Nội dung |
| --- | --- |
| **Nhà** | Điểm sức khỏe tài chính, tiền có thể dùng, dải kỳ (so nhịp tiêu với nhịp thời gian), cảnh báo rủi ro, 6 chỉ số thành phần, nhắc ngân sách, mục tiêu, xu hướng tiết kiệm, số dư từng tài khoản, nhận xét AI hằng ngày. |
| **Nhập** | Ghi chi / thu / chuyển khoản nội bộ. Hiểu cách viết tắt `500k`, `1tr`, `2tr5`. Ghi lùi ngày được. Khoản chi từ 1 triệu trở lên sẽ hỏi có muốn mô phỏng trước không. |
| **Sổ** | Toàn bộ giao dịch, nhóm theo ngày, tìm kiếm, lọc theo loại, sửa và xóa. |
| **Kế hoạch** | Ngân sách theo kỳ (có gợi ý từ lịch sử), mục tiêu tài chính, khoản định kỳ, dự báo dòng tiền 6 kỳ, mô phỏng khoản chi lớn. |
| **Cài đặt** | Kết nối, tạo tab, tài khoản, danh mục, luật tự động phân loại, tải CSV. |

**Kỳ tài chính** là ý tưởng tổ chức của cả app: mặc định từ ngày 15 tháng này
đến 14 tháng sau, không phải tháng dương lịch. Mọi phép tính theo chu kỳ —
ngân sách, tỷ lệ tiết kiệm, số kỳ cầm cự, dự báo — đều tính theo kỳ này.

**Khoản định kỳ** tự biến thành giao dịch khi đến hạn, ngay lần mở app kế tiếp.
Nếu bỏ lỡ vài kỳ, nó ghi bù cho tới hiện tại.

**Tự động phân loại**: đặt luật kiểu `highlands → Cà phê/Trà sữa` ở Cài đặt. Khi
ghi giao dịch mà bỏ trống danh mục, mô tả chứa từ khóa đó sẽ được xếp tự động.

**AI** chỉ diễn giải những con số đã tính sẵn bằng JavaScript, không bao giờ tự
tính ra số mới. Không có `GEMINI_API_KEY` thì các phần AI tự ẩn đi, mọi thứ còn
lại chạy bình thường.

---

## Các tab trong bảng tính

Nút "Tạo tab còn thiếu" tự lo hết phần này — bảng dưới chỉ để tra cứu khi bạn
muốn sửa dữ liệu trực tiếp trong Sheet.

| Tab | Các cột |
| --- | --- |
| `Accounts` | `id, name, type, balance, is_active` |
| `Categories` | `id, name, kind, parent_id, necessity, stability` |
| `Transactions` | `id, occurred_at, amount, direction, account_id, category_id, description, source` |
| `PeriodBudgets` | `id, category_id, period_id, amount` |
| `Goals` | `id, name, goal_type, target_amount, deadline, account_id, created_at, is_active` |
| `Recurring` | `id, name, amount, direction, account_id, category_id, frequency, next_due, is_active` |
| `Rules` | `id, pattern, category_id, priority, hit_count, created_from` |

Vài quy ước quan trọng nếu sửa tay:

- `amount` **luôn dương**; dấu nằm ở `direction` (`in` / `out`).
- Chuyển khoản nội bộ được ghi thành **hai giao dịch** (một `out`, một `in`),
  cùng gắn danh mục có `kind = transfer`. Mọi phép tính thu/chi đều loại trừ
  danh mục loại này, nên chuyển tiền giữa các tài khoản của bạn không làm phồng
  thu nhập hay chi tiêu.
- `necessity` (`essential`/`optional`) nuôi các chỉ số rủi ro; `stability`
  (`fixed`/`variable`) nuôi gợi ý ngân sách và chỉ số "chi cố định". Điền hai
  cột này cho danh mục chi tiêu thì app mới nói được nhiều điều.
- Thẻ tín dụng (`type = credit_card`) không được tính vào "tiền có thể dùng".

---

## Sửa code

Không có bước build. Sửa file, lưu, tải lại trang.

```
sheet-lite/
├── index.html                  khung trang + form nhập giao dịch
├── assets/
│   ├── app.css                 toàn bộ giao diện (biến màu ở đầu file)
│   ├── core.js                 kết nối, gọi API, định dạng số, đọc "2tr5"
│   ├── views.js                các hàm dựng HTML cho từng màn hình
│   └── app.js                  trạng thái, chuyển tab, xử lý thao tác
└── apps-script/
    ├── Code.gs                 toàn bộ phần chạy trên máy chủ
    └── test/test_code.js       bộ test chạy bằng Node
```

Đổi màu chủ đạo: sửa các biến `--brand`, `--out`, `--in` ở đầu `app.css`
(nhớ sửa ở cả ba khối `:root`, `[data-theme="light"]`, `[data-theme="dark"]`).

Sau khi sửa `Code.gs`, phải **Triển khai → Quản lý bản triển khai → sửa (✏) →
Phiên bản: Mới → Triển khai** thì URL cũ mới chạy code mới.

### Chạy test

```bash
node sheet-lite/apps-script/test/test_code.js
```

Bộ test nạp `Code.gs` thật vào Node và giả lập môi trường Apps Script bằng một
bảng tính trong bộ nhớ — không cần Sheet thật, không cần deploy. Nó phủ phần dễ
sai nhất: phép tính tiền, ranh giới kỳ, cân đối số dư khi sửa/xóa giao dịch, và
các trường hợp lỗi không được để lại dữ liệu rác.

---

## Quan hệ với app Flask trong repo này

Thư mục `src/` là bản gốc: Python + SQLite, chạy bằng máy chủ Flask, nhiều tính
năng hơn (nhập giao dịch từ ảnh chụp màn hình qua Gemini, kế hoạch sự kiện,
phát hiện quy luật mùa vụ, ngữ cảnh vĩ mô).

Bản Sheet-lite cố ý dùng **cùng một mô hình dữ liệu** để có thể lớn dần theo
hướng đó mà không phải viết lại. Chỗ nào đơn giản hơn thì có ghi rõ lý do ngay
trong phần chú thích đầu file `Code.gs`.

Hai bản **không chia sẻ dữ liệu** — chúng là hai sổ riêng biệt.

---

## Nếu gặp trục trặc

| Hiện tượng | Nguyên nhân thường gặp |
| --- | --- |
| "Không kết nối được với Apps Script" | URL sai, hoặc bản triển khai chưa để "Bất kỳ ai có đường liên kết". |
| "Sai token" | `APP_TOKEN` trong Script Properties khác với mật khẩu đã nhập. |
| Sửa `Code.gs` rồi mà không thấy đổi | Chưa tạo **phiên bản mới** khi triển khai lại. |
| Ngày lệch một hôm | Múi giờ dự án Apps Script chưa đặt về Vietnam Time. |
| Phần AI không hiện | Chưa đặt `GEMINI_API_KEY`. Đây là hành vi bình thường, không phải lỗi. |
| Mất kết nối sau khi đổi máy/trình duyệt | URL và mật khẩu lưu theo từng trình duyệt. Nhập lại ở màn hình đầu. |
