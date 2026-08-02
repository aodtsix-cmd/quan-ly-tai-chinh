# Sổ tài chính — bản Sheet-lite

Sổ tài chính cá nhân chạy hoàn toàn trên **Google Sheets** (làm cơ sở dữ liệu) +
**Google Apps Script** (làm API) + **một trang HTML tĩnh** (làm giao diện).
Không cần máy chủ, không cần cài đặt gì, không có bước build. Đưa lên GitHub
Pages là dùng được từ điện thoại.

Dữ liệu tài chính nằm trong bảng tính Google của chính bạn. Trang web chỉ là
giao diện — nó không lưu gì ngoài địa chỉ kết nối trong trình duyệt máy bạn.

**Bản đang chạy:** https://aodtsix-cmd.github.io/quan-ly-tai-chinh/sheet-lite/

---

## Cài đặt lần đầu (khoảng 5 phút)

Bạn chỉ cần tạo một bảng tính trắng — mã sẽ tự dựng mọi thứ còn lại.

### 1. Tạo bảng tính trắng

Vào [sheets.new](https://sheets.new) để tạo một Google Sheet mới. Không cần
tạo tab, không cần đặt tên cột — bước 3 lo hết.

### 2. Dán mã Apps Script

Trong bảng tính: **Tiện ích mở rộng → Apps Script**. Xóa hết nội dung mẫu, dán
toàn bộ [`apps-script/Code.gs`](apps-script/Code.gs) vào. Bấm lưu (💾).

### 3. Chạy thiết lập

Vẫn trong Apps Script: chọn hàm **`setupEverything`** ở ô thả xuống trên cùng,
bấm **Chạy**. Google sẽ hỏi cấp quyền lần đầu — chọn tài khoản của bạn, bấm
"Nâng cao" → "Đi tới ... (không an toàn)" → "Cho phép". Đây là cảnh báo mặc
định cho mọi script tự viết; script này chỉ đọc/ghi đúng bảng tính đang mở.

Nó sẽ tạo đủ 7 tab, nạp sẵn tài khoản + cây danh mục tiếng Việt, đặt múi giờ,
và **hiện ra MÃ KẾT NỐI** — chép mã đó lại.

> Sau này bạn cũng có thể chạy lại từ menu **Sổ tài chính** ngay trên thanh
> công cụ của bảng tính (menu này hiện ra sau khi tải lại trang bảng tính).

### 4. Triển khai Web App

**Triển khai → Bản triển khai mới → chọn loại "Ứng dụng web"**:

- Thực thi với tư cách: **Tôi**
- Ai có quyền truy cập: **Bất kỳ ai có đường liên kết**

Bấm Triển khai rồi **copy URL** (dạng `https://script.google.com/macros/s/…/exec`).

> Phải chọn "Bất kỳ ai có đường liên kết" thì trang web mới gọi được. Script
> vẫn chạy dưới quyền của bạn và vẫn chặn mọi request không có đúng mã kết nối.

### 5. Mở app và nối vào bảng tính

Chỗ này dễ nhầm, vì có **hai đường link khác nhau**:

| | Là gì | Dùng thế nào |
| --- | --- | --- |
| **Link app** | `aodtsix-cmd.github.io/quan-ly-tai-chinh/sheet-lite/` | Cái bạn mở hằng ngày. Cố định, không đổi. |
| **Link bảng tính** | `script.google.com/macros/s/…/exec` | "Cửa vào" bảng tính riêng của bạn, lấy ở bước 4. **Không mở trực tiếp link này.** |

Mở **link app** trên điện thoại hoặc máy tính. Lần đầu vào, nó hiện một màn hình
có đúng hai ô:

1. **Địa chỉ bảng tính** → dán link bảng tính ở bước 4
2. **Mã kết nối** → dán mã ở bước 3
3. Bấm **Bắt đầu**

Xong. Trình duyệt nhớ luôn, từ lần sau mở link app là vào thẳng sổ.

Sở dĩ cần bước này: link app là một trang tĩnh trên GitHub, ai mở cũng được và
nó không tự biết bảng tính của bạn nằm ở đâu. Hai ô trên là thứ nối chúng lại,
và chỉ được lưu trong trình duyệt máy bạn.

Nếu bạn lỡ bỏ qua bước 3, cũng không sao: lần đầu app gọi vào, mã sẽ tự dựng các
tab còn thiếu. Chỉ có mã kết nối là phải lấy từ bảng tính (menu **Sổ tài chính →
② Xem mã kết nối**).

### 6. (Tùy chọn) Thêm vào màn hình chính iPhone

Mở trang bằng Safari → nút Chia sẻ → **Thêm vào MH chính**. Nó chạy như một app
riêng, có icon, không thanh địa chỉ.

### 7. (Tùy chọn) Bật phần AI

Trong Apps Script: **Cài đặt dự án (⚙) → Thuộc tính tập lệnh** → thêm khóa
`GEMINI_API_KEY` với key lấy miễn phí ở
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Không có key
thì các phần AI tự ẩn, mọi thứ còn lại chạy bình thường.

Cùng chỗ đó, `PERIOD_START_DAY` đổi được ngày bắt đầu kỳ (mặc định `15`).

---

## Có gì trong này

| Tab | Nội dung |
| --- | --- |
| **Nhà** | Điểm sức khỏe tài chính, tiền có thể dùng, dải kỳ (so nhịp tiêu với nhịp thời gian), cảnh báo rủi ro, 6 chỉ số thành phần, nhắc ngân sách, mục tiêu, xu hướng tiết kiệm, số dư từng tài khoản, nhận xét AI hằng ngày. |
| **Nhập** | Ghi chi / thu / chuyển khoản nội bộ. Hiểu cách viết tắt `500k`, `1tr`, `2tr5`. Ghi lùi ngày được. Khoản chi từ 1 triệu trở lên sẽ hỏi có muốn mô phỏng trước không. |
| **Sổ** | Toàn bộ giao dịch, nhóm theo ngày, tìm kiếm, lọc theo loại, sửa và xóa. |
| **Kế hoạch** | Ngân sách theo kỳ (có gợi ý từ lịch sử), mục tiêu tài chính, khoản định kỳ, dự báo dòng tiền 6 kỳ, mô phỏng khoản chi lớn. |
| **Cài đặt** | Kết nối, kiểm tra thiết lập, tài khoản, danh mục, luật tự động phân loại, tải CSV. |

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

`setupEverything` tự lo hết phần này — bảng dưới chỉ để tra cứu khi bạn muốn
sửa dữ liệu trực tiếp trong Sheet.

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
| Sửa `Code.gs` rồi mà không thấy đổi | Chưa tạo **phiên bản mới** khi triển khai lại. Vào Cài đặt trong app xem số "mã v…" để biết bản nào đang chạy. |
| Không rõ thiếu gì | Cài đặt → **Kiểm tra thiết lập**, nó liệt kê từng mục đạt/chưa đạt. |
| Phần AI không hiện | Chưa đặt `GEMINI_API_KEY`. Đây là hành vi bình thường, không phải lỗi. |
| Mất kết nối sau khi đổi máy/trình duyệt | URL và mật khẩu lưu theo từng trình duyệt. Nhập lại ở màn hình đầu. |
