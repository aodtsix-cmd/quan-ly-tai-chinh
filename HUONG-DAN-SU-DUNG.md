# Hướng dẫn sử dụng (dành cho người mới, không cần biết code)

Tài liệu này giải thích 3 việc:
1. "Đẩy code lên GitHub" nghĩa là gì, tại sao thỉnh thoảng Claude hỏi bạn việc đó.
2. Dùng app chính (Flask) hằng ngày ra sao.
3. Cài đặt và dùng bản **Sheet-lite** (bản nhẹ, không cần máy tính chạy server) từ con số 0.

---

## 1. "GitHub", "commit", "push" là gì?

- **GitHub** giống như một ổ đĩa trên mạng, chuyên để lưu code. Toàn bộ code của dự án này đang nằm ở đây:
  `https://github.com/aodtsix-cmd/quan-ly-tai-chinh`
- **Commit** giống như một "điểm lưu" (giống lưu game): mỗi lần Claude sửa xong một việc, nó gói các thay đổi lại thành 1 điểm lưu, kèm mô tả ngắn đã sửa gì.
- **Push** = gửi các điểm lưu đó lên GitHub, để code không chỉ nằm trên máy đang chạy Claude Code (máy đó có thể tắt, đổi, mất) mà còn có 1 bản sao an toàn trên mạng, kèm lịch sử đầy đủ mọi lần sửa.
- **Bạn không cần làm gì cả** — mỗi khi Claude hỏi "có muốn commit + push không", bạn chỉ cần trả lời "có" hoặc "chưa cần". Đó là toàn bộ việc bạn cần biết.
- Muốn xem lại lịch sử các lần sửa: vào link GitHub ở trên, bấm vào chữ **"commits"** (thường thấy gần đầu trang) — mỗi dòng là một lần Claude đã sửa gì, kèm ngày giờ.

---

## 2. Dùng app chính (Flask) hằng ngày

App chính chạy trên máy tính đang mở Claude Code, tại địa chỉ dạng `http://<địa-chỉ-IP>:8000` (Claude sẽ cho bạn link cụ thể khi server đang chạy). Lưu ý quan trọng: **máy tính đó phải đang bật và server đang chạy thì mới vào được** — đây chính là lý do bản Sheet-lite (phần 3) ra đời, để dùng được cả khi không có server nào chạy.

Các trang chính, theo đúng thói quen dùng hằng ngày:
- **Trang chủ** (`/`) — xem điểm sức khỏe tài chính, số dư, nhắc nhở.
- **Thêm** (`/add`) — nhập giao dịch mới (chi/thu/chuyển khoản).
- **Danh sách** (`/transactions`) — xem/sửa/xóa giao dịch, xuất file CSV.
- **Ngân sách**, **Mục tiêu**, **Sức khỏe TC** — các trang chuyên sâu hơn.

---

## 3. Cài đặt bản Sheet-lite (làm 1 lần)

Bản này dùng **1 Google Sheet** làm nơi lưu dữ liệu (thay cho database), và **1 trang web tĩnh** để nhập/xem — không cần máy tính nào chạy server. Làm theo đúng thứ tự dưới đây, mỗi bước chỉ vài phút.

### Bước 1 — Xem code trên GitHub

Vào link: `https://github.com/aodtsix-cmd/quan-ly-tai-chinh/tree/main/sheet-lite`

Bạn sẽ thấy 3 thứ:
- `index.html` — trang web bạn sẽ dùng hằng ngày.
- `apps-script/Code.gs` — đoạn code sẽ dán vào Google Sheet.
- `README.md` — hướng dẫn dành cho người biết code hơn (bản bạn đang đọc đây dễ hiểu hơn, cứ theo bản này).

### Bước 2 — Tạo Google Sheet

1. Vào [sheets.google.com](https://sheets.google.com), bấm dấu **+** để tạo bảng tính mới.
2. Đổi tên file (góc trên bên trái) thành ví dụ "Tài chính của tôi".
3. Dưới cùng màn hình có 1 tab tên "Sheet1" — click phải vào đó, chọn **Đổi tên**, đặt tên chính xác là `Accounts`.
4. Bấm dấu **+** cạnh tab để thêm tab mới, đặt tên chính xác là `Categories`.
5. Thêm 1 tab nữa, đặt tên chính xác là `Transactions`.

   *(Viết hoa/thường phải đúng y như trên — đây là quy ước tên cố định trong code, không đổi được.)*

6. Vào tab **Accounts**, gõ vào hàng đầu tiên (mỗi ô 1 cột):
   ```
   id    name    type    balance    is_active
   ```
   Hàng thứ 2, nhập tài khoản thật đầu tiên của bạn, ví dụ:
   ```
   1     Ngân hàng ABC    bank    0    TRUE
   ```

7. Vào tab **Categories**, hàng đầu tiên:
   ```
   id    name    kind    parent_id
   ```
   Từ hàng thứ 2 trở đi, nhập vài danh mục ban đầu, ví dụ:
   ```
   1     Ăn uống              expense
   2     Lương                income
   3     Chuyển khoản nội bộ  transfer
   ```
   Lưu ý: **bắt buộc phải có ít nhất 1 dòng `kind` là `transfer`** (như dòng số 3 ở trên) — nếu không, tính năng "Chuyển khoản" sẽ báo lỗi.

8. Vào tab **Transactions**, hàng đầu tiên (không cần nhập gì thêm, để trống bên dưới):
   ```
   id    occurred_at    amount    direction    account_id    category_id    description    source
   ```

### Bước 3 — Dán code vào Apps Script

1. Vẫn đang mở Google Sheet vừa tạo, vào menu **Tiện ích mở rộng (Extensions) → Apps Script**.
2. Một tab mới mở ra, có sẵn 1 đoạn code mẫu (`function myFunction() {...}`) — **bôi đen xóa hết**.
3. Quay lại link GitHub ở Bước 1, mở file `Code.gs`, bấm nút **"Copy raw file"** (hoặc bôi đen toàn bộ nội dung rồi copy) để lấy toàn bộ nội dung.
4. Dán vào ô trống trong Apps Script (chỗ bạn vừa xóa).
5. Bấm biểu tượng **💾 lưu** (hoặc Ctrl+S / Cmd+S) ở trên cùng.

### Bước 4 — Đặt mật khẩu riêng và múi giờ

1. Bên trái màn hình Apps Script, bấm biểu tượng **⚙️ Project Settings**.
2. Kéo xuống mục **Script Properties**, bấm **Add script property**.
3. Ô "Property": gõ đúng `APP_TOKEN`. Ô "Value": tự đặt 1 mật khẩu bất kỳ (chỉ mình bạn biết, dùng để khóa trang web không cho người lạ ghi dữ liệu).
4. Cùng trang Project Settings, tìm mục **Time zone**, chọn **(GMT+07:00) Vietnam Time** — nếu bỏ qua bước này, tổng thu/chi "tháng này" có thể tính sai vài ngày đầu/cuối tháng.

### Bước 5 — Xuất bản (Deploy) thành trang web

1. Quay lại tab soạn code (bấm **< Editor** bên trái nếu cần), bấm nút **Deploy** (góc trên bên phải) → **New deployment**.
2. Bấm biểu tượng bánh răng cạnh "Select type", chọn **Web app**.
3. Điền:
   - Execute as: **Me** (email của bạn)
   - Who has access: **Anyone with the link**
4. Bấm **Deploy**. Google sẽ hỏi cấp quyền — chọn tài khoản Google của bạn, nếu hiện cảnh báo "Google chưa xác minh ứng dụng này", bấm **Advanced (Nâng cao)** rồi **Go to ... (unsafe)** — đây là bình thường, vì đây là code của chính bạn, chạy trên Sheet của chính bạn, không phải app lạ.
5. Sau khi xong, màn hình hiện ra 1 đường link dạng `https://script.google.com/macros/s/....../exec` — **copy và lưu lại link này**, sẽ cần dùng ở bước sau.

### Bước 6 — Mở trang web và kết nối

1. Quay lại GitHub, vào file `index.html` trong thư mục `sheet-lite`, bấm nút tải xuống (hoặc "Copy raw file" rồi dán vào 1 file mới đặt tên `index.html` trên máy bạn).
2. Mở file đó bằng cách double-click (sẽ tự mở bằng trình duyệt).
3. Trang hỏi 2 ô: dán đường link đã copy ở Bước 5 vào ô **Web App URL**, và mật khẩu đã đặt ở Bước 4 vào ô **Token**.
4. Bấm **"Lưu và bắt đầu"**. Từ giờ trình duyệt sẽ tự nhớ, không cần nhập lại (trừ khi đổi trình duyệt/máy khác).

**Xong!** Từ giờ mỗi lần muốn dùng, chỉ cần mở lại đúng file `index.html` đó.

---

## 4. Dùng Sheet-lite hằng ngày

- **Thêm tài khoản mới** (ví dụ mở thêm 1 ngân hàng khác): bấm "+ Thêm tài khoản mới" ở thẻ đầu tiên.
- **Thêm danh mục mới**: bấm "+ Thêm danh mục" ở thẻ thứ hai.
- **Ghi giao dịch**: chọn Chi tiền / Thu tiền / Chuyển khoản, điền số tiền (gõ tắt được: `500k`, `1tr`, `2tr5` đều hiểu), bấm Lưu.
- **Xóa giao dịch**: bấm nút "Xóa" cạnh giao dịch trong danh sách.
- Muốn xem/sửa dữ liệu thô: mở lại chính Google Sheet đã tạo ở Bước 2 — mọi thứ nằm ở đó, xem/sửa trực tiếp cũng được (nhưng nên ưu tiên dùng trang web để số dư luôn được tính đúng).

---

## 5. Câu hỏi thường gặp

**Sửa code xong (Claude báo đã sửa `Code.gs`), giờ sao?**
Vào lại Apps Script, dán đè bản code mới nhất từ GitHub vào, lưu lại, rồi vào **Deploy → Manage deployments**, bấm biểu tượng bút chì cạnh bản deploy đang dùng, chọn **New version**, bấm **Deploy**. (Không cần đổi link — chỉ cần làm bước này thì link cũ vẫn dùng được với code mới.)

**Mở trang web báo "Không kết nối được với Apps Script"?**
Kiểm tra lại đã dán đúng URL và Token chưa (bấm "Đổi kết nối / cài đặt lại" ở cuối trang để nhập lại).

**Muốn dùng bản Sheet-lite trên điện thoại?**
Có thể đưa file `index.html` lên GitHub Pages (miễn phí, có link công khai) — phần này cần thêm bước, hỏi Claude khi bạn sẵn sàng làm.

**2 bản (app chính và Sheet-lite) có dùng chung dữ liệu không?**
Không — đây là 2 nơi lưu dữ liệu hoàn toàn tách biệt (1 bên là file trên máy tính, 1 bên là Google Sheet). Ghi ở bên nào chỉ hiện ở bên đó.
