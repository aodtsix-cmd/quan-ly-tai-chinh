# Brief cho Claude Code — sheet-lite v3
### Danh sách sửa lỗi & phát triển · repo `quan-ly-tai-chinh` · branch `main`

> **Cách dùng:** dán toàn bộ file này vào Claude Code.
> **Yêu cầu chung (đọc trước khi làm bất cứ việc nào):**
> - Đọc `CLAUDE.md` và `docs/UI-DESIGN-SPEC.md` trước.
> - Chỉ động vào thư mục `sheet-lite/` (đây là bản đang phát triển). KHÔNG đụng bản Flask (`src/…`) trừ khi mình nói rõ.
> - **Làm từng việc một, không gộp.** Sau mỗi việc: nói đã sửa file nào, dòng nào, và cách mình tự kiểm chứng.
> - **Nút delegated phải verify bằng cách BẤM thật, không phải chỉ render ra.** Sau khi đụng vào click-handler, chạy lại two-way audit (mọi id trong selector có case, mọi case có id).
> - Không collapse cấu trúc nhiều file về 1 file (`core.js`/`views.js`/`app.js` tách ra là cố ý). Giữ plain `<script src>`, không ES module (phải chạy được qua `file://`).

---

## Việc 1 — Import nhiều ảnh giao dịch cùng lúc (≥10 ảnh)

**Mong muốn:** nhập một lúc nhiều ảnh chụp giao dịch, tối thiểu 10, càng nhiều càng tốt.

**Hiện trạng (theo `CLAUDE.md` v3.5):** đã có `actionAnalyzeImage_` (gửi 1 ảnh sang Gemini) + `actionImportTransactions_` (chỉ ghi các dòng người dùng đã xác nhận). Browser đã downscale ảnh xuống 1280px cạnh dài trước khi gửi.

**Cần làm:**
1. Cho phép chọn **nhiều file ảnh** cùng lúc (input `multiple`), tối thiểu 10.
2. Xử lý **tuần tự từng ảnh** (không gửi song song ồ ạt — tránh vượt payload limit và rate limit của Apps Script/Gemini). Mỗi ảnh vẫn downscale 1280px như hiện tại.
3. **Gộp kết quả về một màn review chung** trước khi ghi: mỗi dòng độc lập, một dòng lỗi (sai số tiền / thiếu tài khoản) chỉ skip dòng đó, phần còn lại vẫn lưu.
4. Giữ nguyên **dedupe bằng `external_ref`** (MD5 của amount+direction+note) — ảnh trùng báo "đã nhập trước đó", không ghi hai lần.
5. Hiển thị tiến độ: "Đang phân tích ảnh 3/12…".

**Ràng buộc an toàn (không được phá):** *review-before-insert* — ảnh không bao giờ ghi thẳng vào sổ; chỉ ghi sau khi người dùng xác nhận. Giữ nguyên test khẳng định `analyze_image` không đụng vào Transactions sheet lẫn số dư.

**Lưu ý:** chất lượng trích xuất từ ảnh **chưa được kiểm chứng với screenshot thật** (chưa có `GEMINI_API_KEY` lúc build). Thiết kế phải giả định đọc sai là chuyện thường và làm cho việc sửa dễ — đừng tin tuyệt đối vào kết quả OCR.

---

## Việc 2 — Thiết kế lại giao diện (design chưa đạt)

**Mong muốn:** giao diện đẹp và trực quan hơn.

**Cần làm:** bám theo `docs/UI-DESIGN-SPEC.md` — nhưng **việc này KHÔNG làm ở đây**. Đây là việc lớn, nên tách riêng qua **Claude Design** (dựng UI → handoff về Code). Ở luồng Claude Code hiện tại, chỉ cần:
1. Sửa các lỗi bố cục cụ thể ở Việc 5, 6, 7 (dưới) — đó là những chỗ "design chưa xong" đo đếm được.
2. Không tự ý đại tu toàn bộ `app.css` khi chưa có bản thiết kế mới từ Design.

> Nói cách khác: đừng redesign mù ở đây. Sửa các lỗi UI cụ thể trước; phần làm đẹp tổng thể để Claude Design lo.

---

## Việc 3 — Các nút đóng/mở chưa hoạt động (dấu X đóng không dùng được)

**Hiện trạng:** app hiện chỉ cho lưu, còn mấy nút X (đóng dialog/thẻ) bấm không có tác dụng.

**Chẩn đoán (nghi ngờ mạnh):** đây gần như chắc là **lỗi delegated-selector** đã xảy ra 2 lần trước trong repo này — nút được thêm vào `switch` của click-handler nhưng **quên thêm vào `closest(...)` selector**, nên nút render ra mà bấm không chạy gì (`#save-connection-anyway` và `#tx-save` từng dính đúng lỗi này).

**Cần làm:**
1. Rà mọi nút đóng/X trong `app.js`: kiểm tra từng id **vừa có trong `closest(...)` selector, vừa có `case` xử lý**.
2. Chạy **two-way audit** (mọi id trong selector có case; mọi case có id trong selector).
3. **Bấm thử thật từng nút X** để xác nhận, không chỉ khẳng định nó hiện ra.
4. Nếu là nút `type="submit"` bị dính cả submit lẫn click → chỉ để một đường (submit event), gỡ khỏi click path.

---

## Việc 4 — Ngày/giờ chưa đúng thời gian thực

**Hiện trạng:** ngày & giờ hiển thị lệch so với thời gian thực.

**Chẩn đoán (nghi ngờ mạnh):** đây là lỗi **timezone** — `CLAUDE.md` ghi rõ getting timezone sai "âm thầm dịch mọi ngày đi một ngày". Quy tắc đã chốt: dùng **timezone của spreadsheet** (`getTimeZone_()`, đã pin `Asia/Ho_Chi_Minh` trong `actionSetup_`), **KHÔNG** dùng `Session.getScriptTimeZone()` (đã bỏ hết caller, đừng đưa lại).

**Cần làm:**
1. Kiểm tra mọi chỗ format/parse ngày ở cả `Code.gs` và frontend (`core.js`).
2. Đảm bảo backend dùng `getTimeZone_()`; frontend hiển thị đúng giờ VN.
3. Kiểm tra riêng `occurred_at` (giao dịch backdate) và timestamp mặc định "hôm nay".
4. Test một giao dịch tạo lúc gần nửa đêm để chắc không bị nhảy ngày.

---

## Việc 5 — Ảnh 1: bấm bị nhảy về đầu + chưa đẹp + thêm biểu đồ/chart

Gồm 3 phần:

**5a. Bấm là nhảy về đầu trang (bất tiện nhất):**
- **Chẩn đoán:** view bị **re-render toàn bộ** sau mỗi click (kiến trúc v3 render wholesale từ `App.state.data`), làm mất vị trí cuộn.
- **Cần làm:** giữ lại vị trí cuộn (scroll position) khi re-render, hoặc chỉ re-render đúng phần thay đổi thay vì cả view. Nhắc lại nguyên tắc trong `CLAUDE.md`: **form Nhập không bao giờ được re-render nền** — kiểm tra xem có phải form/list đang bị cuốn vào re-render không.

**5b. Chưa đẹp:** ghi nhận, xử lý chung ở luồng Claude Design (Việc 2). Ở đây chỉ sửa cái nhảy-về-đầu.

**5c. Thêm biểu đồ/chart minh họa:**
- App đã có sẵn **SVG tự vẽ inline** (`App.sparkline`, `App.lineChart`) — không dùng CDN.
- **Cần làm:** thêm chart ở chỗ hợp lý (ví dụ: xu hướng số dư, chi tiêu theo kỳ, hoặc "dải kỳ" period ribbon trong spec). Dùng đúng cơ chế SVG hiện có, **không thêm Chart.js/CDN** (cả trang không phụ thuộc gì là điểm bán hàng).

---

## Việc 6 — Mở trên điện thoại bị tràn khung viền

**Hiện trạng:** trên điện thoại, các khung/viền bị tràn ra ngoài.

**Cần làm:**
1. Rà `app.css` cho overflow: kiểm tra `width`/`max-width` (dùng `max-width: 100%`, `box-sizing: border-box`), phần tử có nội dung dài (số tiền, tên dài) không đẩy khung rộng ra.
2. Kiểm tra viewport meta và safe-area (iPhone có notch — `env(safe-area-inset-*)`).
3. Test ở bề rộng ~390px và nhỏ hơn (~360px).
4. Chú ý các bảng/scroll ngang (bảng kịch bản mô phỏng) — cho scroll ngang trong khung, không tràn cả trang.

---

## Việc 7 — Ảnh 2: chỗ này chưa design xong

**Hiện trạng:** màn ở ảnh 2 chưa hoàn thiện phần thiết kế.

**Cần làm:** xác định rõ đây là màn nào (mình sẽ chỉ trong ảnh khi làm), liệt kê những phần còn thiếu, rồi hoàn thiện markup/CSS cơ bản cho nó **chạy được và không vỡ layout**. Phần làm đẹp tổng thể để Claude Design.

> Khi làm việc này, hỏi lại mình để mình chỉ chính xác màn nào và thiếu gì.

---

## Việc 8 — Parse số tiền viết tắt: `10tr` = 10.000.000, `1tr` = 1.000.000

**Mong muốn:** khi nhập, `10tr` phải ra 10.000.000; nếu không phân tách thì gõ `1tr` dễ nhầm thành 1.000.000 hay 10tr — phải rõ ràng.

**Hiện trạng (theo `CLAUDE.md`):** bản `sheet-lite` v3.5 **đã có** amount parser đọc phần thập phân sau `tr`: `2tr5` = 2.5tr, `1tr25` = 1.25tr, `1tr250` = 1.25tr. (Khác bản Flask `parse_amount_vnd` chỉ nhận 1 chữ số sau `tr`.)

**Cần làm:**
1. **Kiểm tra parser trong `core.js` có xử lý đúng các trường hợp sau không** — nếu thiếu, bổ sung + viết test (`apps-script/test/test_code.js` hoặc test frontend nếu có):
   - `1tr` → 1.000.000
   - `10tr` → 10.000.000
   - `50k` → 50.000
   - `1tr5` → 1.500.000
   - `2tr250` → 2.250.000
   - `1000000` → 1.000.000 (số trần vẫn chạy)
2. **Hiển thị xác nhận trực quan ngay khi gõ:** dưới ô nhập, hiện lại số đã hiểu ở dạng đầy đủ có dấu chấm, ví dụ gõ `10tr` → hiện "= 10.000.000đ". Đây là cách chống nhầm lẫn mình muốn: người dùng thấy ngay hệ thống hiểu đúng ý chưa.
3. **Tuyệt đối không "sửa live" phá số đang gõ** — `CLAUDE.md` ghi rõ lỗi cũ: gõ `1tr` bị reformat từng phím xuống còn `1`. Chỉ hiển thị số-đã-hiểu ở dòng phụ, KHÔNG ghi đè vào ô input khi đang gõ.

---

## Thứ tự đề xuất làm

| Ưu tiên | Việc | Lý do |
|---|---|---|
| 1 | **3** (nút X chết) | Lỗi chặn dùng, có chẩn đoán rõ, sửa nhanh |
| 2 | **4** (ngày/giờ) | Sai dữ liệu gốc, ảnh hưởng mọi thứ theo kỳ |
| 3 | **8** (parse tiền) | Chạm vào mỗi lần nhập, chống nhầm số |
| 4 | **5a** (nhảy về đầu) + **6** (tràn khung) | Trải nghiệm hằng ngày |
| 5 | **1** (import nhiều ảnh) | Tính năng lớn, làm sau khi nền ổn |
| 6 | **5c** (chart) | Bổ sung, không chặn |
| 7 | **2, 7** (design) | Chuyển phần lớn sang Claude Design |

> Sau mỗi việc, chạy lại test suite Node (`node apps-script/test/test_code.js`) nếu có đụng `Code.gs`, và bấm thử thật trên cả desktop lẫn khung điện thoại ~390px.
