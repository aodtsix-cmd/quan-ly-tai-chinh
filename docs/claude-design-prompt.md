# Prompt khởi động cho Claude Design
### Dán toàn bộ phần dưới đây (từ dòng "=== BẮT ĐẦU ===") vào ô chat của Claude Design

> Mẹo: nếu Design cho phép, hãy **đính kèm file `UI-DESIGN-SPEC.md`** cùng lúc — prompt này đã tham chiếu tới nó.
> Nếu không đính kèm được, prompt vẫn tự chứa đủ ngữ cảnh để chạy.

---

=== BẮT ĐẦU ===

Bạn là designer đang dựng UI cho một app **quản lý tài chính cá nhân** (single-user, PWA + desktop web, có dark mode). Mình đã có spec đầy đủ trong file UI-DESIGN-SPEC.md (đính kèm). Hãy đọc nó làm nguồn chân lý, nhưng ở lần này chỉ dựng **2 màn hình dùng mỗi ngày**: (1) **Nhà — Dashboard sức khỏe tài chính** và (2) **Nhập — Thêm giao dịch**.

Xuất ra **HTML/CSS/JS tĩnh, không build step** (app thật chạy được cả khi mở bằng file://), khung mobile-first ~390px, kèm cả bản dark mode.

## Ngôn ngữ thiết kế (bắt buộc giữ đúng)
- **Nền**: trắng (light) / gần đen (dark). **Brand: tím-chàm indigo `#4f46e5`** — cố tình *lùi lại* để màu tiền nổi hơn.
- **Màu tiền có nghĩa** (đây là thứ nổi nhất, không phải brand): chi = gạch `#b4442e`, thu = thông `#2f6f4e`, chuyển nội bộ = thép `#4a6b8a`, cảnh báo = hoàng thổ `#b8860b`.
- **Mọi con số** (tiền, %, ngày) dùng **font monospace bảng (tabular)**; chữ thường dùng font hệ thống. Số dư là phần **to & đậm nhất màn hình**.
- Thẻ bo góc 16px, bóng đổ mềm nhiều lớp (kiểu MoMo), khoảng trắng rộng, vùng chạm ≥ 44px.
- Song ngữ Vi/En (mặc định tiếng Việt), nhưng **số tiền luôn định dạng VND**: ví dụ `3.266.701đ`.

## Khung điều hướng
Bottom tab bar cố định 5 mục kiểu MoMo, **nút giữa nổi bật**:
🏠 Nhà · 📒 Sổ · ➕ **Nhập** (giữa, nổi) · 🎯 Kế hoạch · ⚙️ Cài đặt
(Lần này chỉ cần dựng nội dung cho tab Nhà và Nhập; 3 tab kia để placeholder.)

## MÀN 1 — Nhà (Dashboard), thứ tự từ trên xuống
1. **Hero số dư khả dụng**: thẻ lớn gradient nhẹ theo brand. Số dư ròng cực lớn (font số bảng) + nút 👁 ẩn/hiện. Dòng phụ: "Tiền lời hôm nay +357đ". Kèm **điểm sức khỏe tài chính 0–100** dạng vòng tròn, có nhãn màu xanh/vàng/đỏ.
2. **"Dải kỳ" (period ribbon)** — ĐÂY LÀ ĐIỂM NHẬN DIỆN, hãy làm nổi bật:
   - Tiêu đề: "Kỳ 15/07 – 14/08 · Còn 6 ngày" (app chạy chu kỳ ngày-15-đến-14, KHÔNG phải tháng dương lịch).
   - **Hai thanh ngang trên cùng một thước, xếp chồng**: thanh trên = "Thời gian đã trôi 80%", thanh dưới = "Đã tiêu 62% ngân sách". **Khoảng cách giữa 2 thanh chính là thông điệp** (tiêu chậm/nhanh hơn nhịp thời gian). Thiết kế sao cho đọc được ngay khoảng cách này.
3. **Grid chỉ số sức khỏe** (các thẻ nhỏ, icon grid kiểu MoMo): số ngày "sống sót" nếu mất thu nhập · tỷ lệ tiết kiệm kỳ này · burn rate vs thời gian đã trôi · quy tắc 50/30/20 · thu chắc chắn. Mỗi thẻ: nhãn nhỏ + số lớn (font bảng) + màu ngữ nghĩa.
4. **Thẻ mục tiêu gần nhất** (thanh tiến độ %) + **thẻ sự kiện sắp tới** (ngày + tổng dự kiến).
5. **Thẻ AI tóm tắt hôm nay**: 1–2 câu + nút "Xem chi tiết".

Dữ liệu mẫu để điền: số dư `3.266.701đ`, điểm sức khỏe `72/100` (vàng), tiền lời hôm nay `+357đ`, kỳ còn 6 ngày, thời gian trôi 80% / đã tiêu 62%.

## MÀN 2 — Nhập (Thêm giao dịch), ít ma sát nhất
1. **Ô nhập số tiền cực lớn** trên cùng (font số bảng), placeholder `0đ`. Ghi chú nhỏ: chấp nhận cách viết tắt `1tr`, `50k`.
2. **3 pill lớn chọn loại**: Chi / Thu / Chuyển — pill được chọn đổi màu accent theo màu tiền tương ứng (gạch/thông/thép).
3. Chọn **danh mục** (grid icon), **tài khoản nguồn** (và tài khoản đích nếu là Chuyển).
4. Ô **ghi chú/mô tả**.
5. **Ngày** (mặc định hôm nay, cho phép chọn ngày cũ).
6. Nút **Lưu** to, full-width, màu brand.
7. Gợi ý mềm phía dưới (chỉ hiện khi số ≥ 1.000.000đ): "Mô phỏng tác động khoản chi này?"

## Yêu cầu output
- Cho mình xem **light + dark** cạnh nhau nếu được.
- Ưu tiên đúng **thứ bậc thị giác**: số dư > màu tiền > brand > mọi thứ khác.
- Đừng làm rối; theo triết lý tối giản của MoMo (mỗi màn một tiêu điểm rõ).
- Bắt đầu bằng màn **Nhà** trước, mình sẽ tinh chỉnh rồi mới sang màn Nhập.

Hãy hỏi lại mình nếu có chỗ nào chưa rõ trước khi dựng.

=== KẾT THÚC ===

---

## Sau khi Design dựng xong, gợi ý câu tinh chỉnh tiếp theo
- "Làm dải kỳ (period ribbon) to hơn và cho hai thanh gần nhau hơn để thấy rõ khoảng cách."
- "Đổi sang dark mode và kiểm tra màu tiền còn đủ tương phản không."
- "Giờ dựng màn Nhập theo cùng design system này."
- Khi ưng: bấm **Handoff to Claude Code** → dán bundle vào Claude Code để ghép vào repo `sheet-lite`.
