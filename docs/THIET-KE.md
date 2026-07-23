# THIẾT KẾ SẢN PHẨM — Quản lý tài chính cá nhân

> Tài liệu này mô tả sản phẩm sẽ xây dựng và cách lưu trữ dữ liệu.
> Đọc kỹ và phản hồi trước khi bắt đầu viết code.

---

## PHẦN 1 — SẢN PHẨM LÀM GÌ

### 1.1 Vấn đề cần giải quyết

Người dùng (bắt đầu từ chính tác giả) đã thử Excel và MoMo nhưng bỏ cuộc vì:

| Nguyên nhân | Hệ quả |
|---|---|
| Nhập liệu nhiều bước | Lười, bỏ qua |
| Phải nhập ngay lúc tiêu | Bất tiện, ngại ở nơi công cộng |
| Phải tự phân loại từng khoản | Mệt mỏi, phân vân |
| Nhập xong không thấy lợi ích | Mất động lực |
| Bỏ một hôm là đứt mạch | Bỏ luôn |

**Kết luận:** vấn đề không nằm ở chỗ thiếu công cụ ghi chép, mà ở chỗ *ma sát khi nhập* quá cao so với *lợi ích nhận lại*.

### 1.2 Nguyên tắc thiết kế

Ba nguyên tắc chi phối mọi quyết định sau này:

1. **Giảm ma sát tối đa** — người dùng không nhập tay lúc tiêu tiền. Dữ liệu vào hệ thống bằng con đường tự động hoặc bán tự động; việc phân loại làm theo lô, vào lúc rảnh.

2. **Trả lợi ích ngay** — mỗi lần mở app phải thấy thứ có giá trị, không chỉ là bảng số. Cảnh báo, xu hướng, dự báo.

3. **Nhìn về phía trước, không chỉ phía sau** — sổ ghi chép chỉ kể chuyện đã qua. Sản phẩm này phải trả lời được: *sắp tới tôi có ổn không?*

### 1.3 Ba nhóm chức năng

**A. Ghi nhận (Recording)**
Đưa giao dịch vào hệ thống với ít công sức nhất.

**B. Thấu hiểu (Understanding)**
Biến danh sách giao dịch thành hiểu biết: tiêu vào đâu, xu hướng ra sao, so với tháng trước thế nào.

**C. Phòng ngừa (Guarding)**
Cảnh báo chủ động về rủi ro, và hỗ trợ lập kế hoạch cho sự kiện lớn sắp tới.

---

## PHẦN 2 — NGUỒN DỮ LIỆU

Do hạn chế của iOS (không app nào đọc được thông báo của app khác) và của ngân hàng Việt Nam (không có API cho cá nhân), dữ liệu vào hệ thống qua bốn đường:

| Nguồn | Mức tự động | Phạm vi | Giai đoạn |
|---|---|---|---|
| Email MB (thẻ tín dụng) | Hoàn toàn tự động | Giao dịch thẻ tín dụng | 3 |
| Ảnh chụp lịch sử giao dịch | Bán tự động (OCR) | Tài khoản MB, ví MoMo | 4 |
| Nhập nhanh | Thủ công, tối giản | Tiền mặt, ngoại lệ | 1 |
| Khoản định kỳ | Tự động sinh | Tiền nhà, thuê bao, trả góp | 2 |

**Lưu ý quan trọng:** không có cách tự động hóa 100%. Thiết kế phải chấp nhận điều này và tối ưu cho thực tế đó, thay vì chờ một giải pháp hoàn hảo không tồn tại.

---

## PHẦN 3 — THIẾT KẾ DỮ LIỆU

Đây là phần quan trọng nhất. Cấu trúc dữ liệu quyết định sau này làm được gì và không làm được gì.

### 3.1 Bảng `accounts` — Tài khoản/Nguồn tiền

Mỗi nơi chứa tiền là một bản ghi: tài khoản MB, ví MoMo, thẻ tín dụng, tiền mặt, sổ tiết kiệm.

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `name` | chữ | Tên hiển thị ("MB Thanh toán", "Ví MoMo") |
| `type` | chữ | `bank` / `ewallet` / `credit_card` / `cash` / `savings` |
| `currency` | chữ | Mặc định `VND` |
| `current_balance` | số | Số dư hiện tại |
| `is_liquid` | đúng/sai | Có quy ra tiền mặt ngay được không |
| `is_active` | đúng/sai | Còn dùng hay đã đóng |

**Vì sao cần `is_liquid`:** để tính rủi ro thanh khoản. Tiền trong tài khoản thanh toán khác tiền trong sổ tiết kiệm 12 tháng — cả hai đều là tài sản, nhưng chỉ một cái dùng được ngay khi cần gấp.

### 3.2 Bảng `categories` — Danh mục

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `name_vi` | chữ | Tên tiếng Việt |
| `name_en` | chữ | Tên tiếng Anh (chuẩn bị song ngữ) |
| `parent_id` | số | Danh mục cha (cho phép phân cấp) |
| `kind` | chữ | `expense` / `income` / `transfer` |
| `necessity` | chữ | `essential` / `optional` |
| `stability` | chữ | `fixed` / `variable` |

**Vì sao cần `necessity` và `stability`:** đây là hai trường quyết định khả năng phân tích rủi ro.

- `essential` vs `optional` — khi cần cắt giảm, biết cắt được cái nào. Tiền nhà là thiết yếu; cà phê là tùy chọn.
- `fixed` vs `variable` — chi phí cố định là phần "sàn" không giảm được, dùng để tính *thời gian sống sót* nếu mất thu nhập.

Không có hai trường này, hệ thống chỉ nói được "bạn tiêu 10 triệu", không nói được "trong đó 7 triệu là bắt buộc, bạn chỉ có thể xoay xở 3 triệu".

**Phân cấp danh mục** cho phép: `Ăn uống` → `Ăn ngoài`, `Đi chợ`, `Cà phê`. Xem tổng quan hay chi tiết đều được.

### 3.3 Bảng `transactions` — Giao dịch

Bảng trung tâm của hệ thống.

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `occurred_at` | thời gian | Thời điểm giao dịch |
| `amount` | số | Số tiền (luôn dương) |
| `direction` | chữ | `out` / `in` |
| `account_id` | số | Từ/vào tài khoản nào |
| `category_id` | số | Danh mục (có thể trống lúc đầu) |
| `description` | chữ | Nội dung gốc từ ngân hàng |
| `note` | chữ | Ghi chú của người dùng |
| `source` | chữ | `email` / `ocr` / `manual` / `recurring` |
| `is_reviewed` | đúng/sai | Đã xem và xác nhận chưa |
| `external_ref` | chữ | Mã tham chiếu để chống trùng lặp |
| `created_at` | thời gian | Lúc bản ghi được tạo |

**Vì sao `amount` luôn dương và tách `direction` riêng:** dễ tính toán, tránh nhầm dấu, và cho phép hỏi "tổng tiền ra" mà không cần điều kiện phức tạp.

**Vì sao cần `source`:** biết dữ liệu từ đâu để đánh giá độ tin cậy, và để gỡ lỗi khi nhập sai.

**Vì sao cần `is_reviewed`:** đây là trục xoay của quy trình "cuối tuần ngồi phân loại một lần". Giao dịch tự động vào hệ thống với `is_reviewed = sai`; người dùng mở màn hình "Chờ duyệt", xác nhận hàng loạt.

**Vì sao cần `external_ref`:** nếu chụp ảnh trùng ngày hoặc chạy đọc email hai lần, hệ thống phải nhận ra giao dịch đã có, không tạo bản sao.

### 3.4 Bảng `behavior_events` — Nhật ký hành vi

**Mục đích:** dữ liệu hành vi (khác với dữ liệu nghiệp vụ ở bảng `transactions`) không thể tái tạo sau khi đã mất. Nếu sau này dùng app làm đối tượng nghiên cứu (NCKH về fintech, hành vi tiêu dùng), phải có dữ liệu này ngay từ đầu — không thể hồi cứu.

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `user_id` | số | Người dùng (chuẩn bị cho đa người dùng) |
| `event_type` | chữ | Loại sự kiện, xem bảng dưới |
| `transaction_id` | số | Giao dịch liên quan (nếu có) |
| `payload` | JSON | Chi tiết sự kiện, dạng linh hoạt |
| `occurred_at` | thời gian | Thời điểm sự kiện xảy ra |

**Các loại `event_type` ghi nhận:**

| Sự kiện | Đo được gì | Liên hệ lý thuyết |
|---|---|---|
| `transaction_reviewed` | Độ trễ từ lúc phát sinh đến lúc người dùng duyệt | Present Bias — khoảng cách giữa hành động và ghi nhận |
| `category_overridden` | Người dùng có sửa danh mục hệ thống gợi ý không | Độ tin cậy của tự động hóa, mức chủ động |
| `alert_shown` | Cảnh báo rủi ro đã hiển thị, nội dung, khung diễn đạt (mất mát/lợi ích) | Loss Aversion — so sánh hiệu quả hai cách đóng khung |
| `alert_acted_on` | Người dùng có hành động sau cảnh báo không, hành động gì | Hiệu quả của Nudge |
| `event_plan_created` | Người dùng lập kế hoạch cho sự kiện lớn (chuyển nhà, cưới...) | Hành vi lập kế hoạch tài chính |
| `session_opened` | Tần suất, thời điểm mở app | Thói quen sử dụng |

**Nguyên tắc đạo đức nghiên cứu:** nếu dữ liệu này dùng cho NCKH có người dùng khác ngoài tác giả, cần có cơ chế thông báo và xin đồng ý (informed consent) — ngay cả ở bản dùng thử nội bộ. Việc này thiết kế thêm ở Giai đoạn 6, nhưng bảng dữ liệu phải có từ Giai đoạn 1.

### 3.5 Bảng `rules` — Luật phân loại tự động

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `pattern` | chữ | Chuỗi cần khớp trong `description` |
| `category_id` | số | Danh mục sẽ gán |
| `priority` | số | Thứ tự ưu tiên khi nhiều luật cùng khớp |
| `hit_count` | số | Số lần đã dùng |
| `created_from` | chữ | `user` / `learned` |

**Cách hoạt động:** giao dịch có nội dung *"Giao dịch chi tiêu tại Google YouTubePremium"* → khớp luật `pattern = "YouTube"` → tự gán danh mục *Thuê bao/Giải trí*.

**Học từ người dùng:** mỗi lần người dùng sửa danh mục của một giao dịch, hệ thống hỏi *"Lần sau có giao dịch chứa 'Highlands' thì xếp vào Cà phê nhé?"* → tạo luật mới. Sau vài tuần, phần lớn giao dịch tự phân loại đúng.

Đây là cơ chế mang lại giá trị lớn nhất của sản phẩm — nó loại bỏ công việc mệt mỏi nhất.

### 3.6 Bảng `recurring` — Khoản định kỳ

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `name` | chữ | Tên ("Tiền nhà", "Netflix") |
| `amount` | số | Số tiền |
| `direction` | chữ | `out` / `in` |
| `category_id` | số | Danh mục |
| `account_id` | số | Tài khoản |
| `frequency` | chữ | `monthly` / `quarterly` / `yearly` |
| `day_of_period` | số | Ngày trong kỳ |
| `next_due` | ngày | Kỳ tiếp theo |
| `is_active` | đúng/sai | Còn hiệu lực |

**Công dụng kép:**
1. Tự sinh giao dịch dự kiến, không cần nhập lại mỗi tháng.
2. Là dữ liệu đầu vào để dự báo — biết trước tháng tới chắc chắn mất bao nhiêu.

### 3.7 Bảng `income_sources` — Nguồn thu nhập

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | số | Mã định danh |
| `name` | chữ | Tên nguồn thu |
| `type` | chữ | `fixed` / `variable` |
| `expected_amount` | số | Mức kỳ vọng |
| `reliability` | số | Độ tin cậy 0–100% |

**Vì sao tách riêng:** thu nhập của người dùng có phần cố định và phần thất thường. Hệ thống phải phân biệt để tính rủi ro đúng — không thể coi khoản thu bấp bênh ngang với lương cứng.

Khi dự báo, chỉ tính phần chắc chắn; phần thất thường coi là phần thưởng, không phải nền tảng.

### 3.8 Bảng `event_templates` và `event_items` — Danh sách sự kiện

Phục vụ chức năng gợi ý khoản mục khi có sự kiện lớn.

**`event_templates`** — các loại sự kiện: chuyển nhà, cưới hỏi, sinh con, mua nhà, mua xe, du lịch, học thêm...

**`event_items`** — các khoản mục thuộc mỗi sự kiện. Ví dụ với "Chuyển nhà":

| Khoản mục | Hay bị quên |
|---|---|
| Tiền cọc nhà mới | Không |
| Xe chuyển đồ | Không |
| Phí môi giới | Có |
| Lắp internet mới | Có |
| Đổi khóa | Có |
| Rèm cửa, đồ dùng thiếu | Có |
| Phí quản lý tháng đầu | Có |
| Điện nước trùng hai nơi | Có |

**Nguyên tắc:** hệ thống **chỉ gợi ý khoản mục, không đưa giá**. Giá do người dùng nhập, vì giá phụ thuộc địa phương và hoàn cảnh — đoán bừa sẽ sai và mất tin cậy.

**`event_plans`** — kế hoạch thực tế người dùng lập từ template, có số tiền dự kiến và số tiền thực tế.

---

## PHẦN 4 — CÁC CHỈ SỐ RỦI RO

Ba loại rủi ro người dùng quan tâm, và cách hệ thống đo:

### 4.1 Hết tiền ngắn hạn

**Câu hỏi:** cuối tháng có đủ tiền không?

**Cách tính:** số dư khả dụng hiện tại − các khoản định kỳ còn lại trong tháng − chi tiêu dự kiến (dựa trên tốc độ chi trung bình).

**Cảnh báo khi:** dự báo âm, hoặc tốc độ chi vượt ngưỡng.

### 4.2 Rủi ro thanh khoản

**Câu hỏi:** cần tiền gấp thì lấy đâu ra?

**Cách tính:** tổng tài sản có `is_liquid = đúng` so với chi phí thiết yếu một tháng.

**Cảnh báo khi:** tài sản lỏng không đủ trang trải một tháng chi phí bắt buộc.

### 4.3 Nền móng tài chính

**Câu hỏi:** nếu mất thu nhập, sống được bao lâu?

**Cách tính:** tài sản lỏng ÷ chi phí thiết yếu hàng tháng = **số tháng sống sót**.

**Mốc tham chiếu:**

| Số tháng | Đánh giá |
|---|---|
| Dưới 1 | Nguy hiểm |
| 1–3 | Mong manh |
| 3–6 | Ổn |
| Trên 6 | Vững |

Đây là chỉ số quan trọng nhất, và là thứ Excel không bao giờ nói cho bạn biết.

---

### 4.4 Cân đối chi tiêu (quy tắc 50/30/20)

**Câu hỏi:** cơ cấu chi tiêu có lành mạnh không?

**Cách tính:** dùng `necessity` ở bảng `categories` để nhóm chi tiêu, so với thu nhập:

| Nhóm | Ngưỡng khuyến nghị | Ứng với |
|---|---|---|
| Thiết yếu (essential) | ≤ 50% thu nhập | `necessity = essential` |
| Tùy chọn (optional) | ≤ 30% thu nhập | `necessity = optional` |
| Tiết kiệm/trả nợ | ≥ 20% thu nhập | Phần dư sau chi tiêu |

**Nguồn:** quy tắc phổ biến trong tài chính cá nhân (Elizabeth Warren, *All Your Worth*, 2005). Đây là ngưỡng tham khảo chung, không phải chuẩn tuyệt đối — hệ thống dùng để **so sánh và cảnh báo lệch hướng**, không áp đặt cứng.

---

## PHẦN 5 — LỘ TRÌNH

| GĐ | Nội dung | Kết quả dùng được | Học được |
|---|---|---|---|
| 1 | Cơ sở dữ liệu + nhập tay + xem danh sách + tổng theo tháng | Sổ chi tiêu chạy trong terminal | Python cơ bản, SQL, cấu trúc dữ liệu |
| 2 | Phân loại tự động + học luật + khoản định kỳ | Bớt hẳn việc phân loại thủ công | Xử lý chuỗi, thuật toán khớp mẫu |
| 3 | Đọc email MB tự động | Giao dịch thẻ tự vào hệ thống | Kết nối dịch vụ ngoài, xử lý bảo mật |
| 4 | OCR ảnh chụp giao dịch | Giao dịch MB/MoMo bán tự động | Xử lý ảnh, trích xuất dữ liệu |
| 5 | Giao diện web | Dùng được trên iPhone, iPad | Web, giao diện người dùng |
| 6 | Chỉ số rủi ro + cảnh báo + kế hoạch sự kiện | Cố vấn tài chính, không chỉ sổ sách | Logic nghiệp vụ, phân tích |
| 7 | Danh mục đầu tư, giá vàng, tỷ giá | Bức tranh tài sản toàn diện | API, dữ liệu thị trường |

**Nguyên tắc:** mỗi giai đoạn phải cho ra thứ dùng được ngay. Không giai đoạn nào phụ thuộc giai đoạn sau.

**Quyết định phân kỳ (đã chốt):** bảng `behavior_events` được **tạo cấu trúc từ Giai đoạn 1**, nhưng chỉ **bắt đầu ghi dữ liệu thật từ Giai đoạn 2**. Lý do: giữ khả năng dùng cho NCKH sau này mà không làm chậm phần lõi ở giai đoạn đầu.

---

## PHẦN 6 — NGUYÊN TẮC KỸ THUẬT

**Bảo mật:**
- Kho mã nguồn để chế độ riêng tư
- Không bao giờ đưa khóa truy cập, mật khẩu, hay dữ liệu thật vào mã nguồn
- File cơ sở dữ liệu không đẩy lên GitHub
- Thông tin nhạy cảm để ở file riêng, chặn bằng `.gitignore`

**Song ngữ:**
- Không viết chữ tiếng Việt trực tiếp trong mã
- Mọi văn bản hiển thị để ở file ngôn ngữ riêng
- Thêm tiếng Anh sau này chỉ cần thêm một file, không sửa mã

**Khả năng mở rộng:**
- Phần lưu trữ tách biệt khỏi phần logic
- Sau này chuyển từ máy cá nhân lên đám mây không phải viết lại toàn bộ

**Chất lượng:**
- Tên biến, tên hàm bằng tiếng Anh
- Mỗi hàm làm một việc
- Có kiểm thử cho phần tính toán tài chính (sai số tiền là sai nghiêm trọng)

---

## PHẦN 7 — CƠ SỞ LÝ THUYẾT

Sản phẩm này không chỉ là công cụ ghi chép — nó cố gắng thay đổi hành vi. Mỗi quyết định thiết kế quan trọng đều bắt nguồn từ một lý thuyết cụ thể, không phải cảm tính. Phần này ghi lại để: (1) giải thích vì sao thiết kế như vậy, (2) làm nền cho NCKH nếu phát triển tiếp theo hướng fintech/hành vi tài chính.

### 7.1 Hai nhóm lý thuyết

**Nhóm hành vi (mô tả)** — giải thích con người thực sự hành xử thế nào, kể cả khi phi lý trí. Dùng để thiết kế *cách* sản phẩm tương tác với người dùng.

**Nhóm chuẩn tắc (quy phạm)** — mô tả *nên* quản lý tiền thế nào. Dùng để thiết kế *nội dung* lời khuyên, ngưỡng cảnh báo.

### 7.2 Lý thuyết hành vi và ứng dụng cụ thể

| Lý thuyết | Tác giả | Nội dung cốt lõi | Áp dụng trong thiết kế |
|---|---|---|---|
| Mental Accounting | Richard Thaler | Con người chia tiền thành các "ngăn" tâm lý riêng, không coi là một khối đồng nhất | Tách bảng `accounts` và `categories` thay vì một số dư tổng duy nhất |
| Present Bias / Hyperbolic Discounting | Thaler, Laibson | Coi trọng lợi ích trước mắt hơn lợi ích tương lai một cách phi lý trí | Giảm chi phí nhập liệu về gần 0; đưa lợi ích lại gần (cảnh báo tức thời thay vì báo cáo cuối tháng) |
| Loss Aversion | Kahneman & Tversky (1979) | Sợ mất mát mạnh hơn ham thích lợi ích tương đương | Cảnh báo đóng khung theo hướng "sắp mất" thay vì "có thể được"; ghi log `alert_shown` để so sánh hiệu quả khung diễn đạt |
| Nudge Theory | Thaler & Sunstein (2008) | Thiết kế mặc định đúng hiệu quả hơn yêu cầu tự giác | Chủ động cảnh báo, tự phân loại, gợi ý khoản mục — không chờ người dùng chủ động hỏi |
| Cognitive Load | Sweller | Càng nhiều bước quyết định, càng dễ bỏ cuộc | Quy trình "chờ duyệt hàng loạt" thay vì phân loại từng giao dịch riêng lẻ |

### 7.3 Lý thuyết chuẩn tắc và ứng dụng cụ thể

| Khung | Nguồn | Nội dung | Áp dụng |
|---|---|---|---|
| Quy tắc 50/30/20 | Elizabeth Warren, *All Your Worth* (2005) | Cơ cấu chi tiêu lành mạnh: 50% thiết yếu, 30% tùy chọn, 20% tiết kiệm | Mục 4.4 |
| Quỹ khẩn cấp 3–6 tháng | Chuẩn phổ biến trong CFP (Certified Financial Planner) | Tài sản lỏng nên đủ trang trải 3–6 tháng chi phí thiết yếu | Mục 4.3 |
| Envelope Budgeting | Phương pháp ngân sách truyền thống | Chia ngân sách cố định theo danh mục, dừng khi hết | Chưa triển khai, dự kiến chế độ hiển thị sau này |

### 7.4 Khoảng trống cần bổ sung nếu phát triển thành NCKH

Các lý thuyết trên chủ yếu đến từ bối cảnh Mỹ/phương Tây. Nếu phát triển thành NCKH nghiêm túc về fintech hoặc hành vi tài chính tại Việt Nam, cần bổ sung:

- Nghiên cứu hành vi tài chính của sinh viên/người trẻ Việt Nam cụ thể (thói quen chi tiêu, mức độ chấp nhận rủi ro, thái độ với tiết kiệm)
- Đặc thù thị trường fintech Việt Nam (hành vi dùng ví điện tử, mức độ tin tưởng ứng dụng tài chính)
- Có thể có khác biệt văn hóa về vai trò gia đình trong quyết định tài chính cá nhân — chưa được các lý thuyết phương Tây phản ánh đầy đủ

**Việc này để lại cho giai đoạn sau**, khi có hướng NCKH cụ thể. Lúc đó tìm kiếm tài liệu thực tế thay vì suy đoán, và bổ sung vào mục này mà không cần sửa cấu trúc dữ liệu đã xây.