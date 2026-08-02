# Hướng dẫn cầm tay: Claude Design → Claude Code
### Dành cho người lần đầu dùng · giải thích như nói chuyện

> Mục tiêu: bạn tự thiết kế được giao diện đẹp ở **Claude Design**, rồi đưa nó sang **Claude Code** để ghép vào app thật.
> Không cần biết code. Đọc từ trên xuống, làm theo.

---

## Phần 0 — Hiểu 2 công cụ trong 30 giây

Hình dung đơn giản:

- **Claude Design = phòng vẽ.** Bạn tả, nó vẽ giao diện. Chỉ ra hình, KHÔNG đụng vào app thật của bạn. An toàn tuyệt đối, vẽ sai cũng không hỏng gì.
- **Claude Code = thợ xây.** Nó sửa code thật trong repo `quan-ly-tai-chinh` của bạn.

Việc bạn sắp làm: **vẽ ở phòng vẽ trước → ưng rồi mới đưa cho thợ xây build.**

Điểm nối 2 bên tên là **"Handoff"** (bàn giao) — một nút bấm sẵn có, không phải làm thủ công.

---

## Phần 1 — Chuẩn bị trước khi vào (5 phút)

Gom sẵn mấy thứ này ra một chỗ (thư mục trên máy, hoặc mở sẵn):

- [ ] File `UI-DESIGN-SPEC.md` (mình đã gửi)
- [ ] File `claude-design-prompt.md` (mình đã gửi — sẽ copy phần trong đó)
- [ ] 2 ảnh chụp app hiện tại của bạn
- [ ] 3–4 ảnh MoMo/Timo bạn thích
- [ ] Ảnh logo "FINANCE"

**KHÔNG cần** file `CLAUDE.md` (quá nặng kỹ thuật, phần cần đã nằm trong spec).

---

## Phần 2 — Vào Claude Design lần đầu

### Bước 2.1 — Mở đúng chỗ
1. Mở trình duyệt, vào địa chỉ: **claude.ai/design**
2. Nếu nó báo "chưa bật / off": vào **Settings → (Organization / Features)** bật Claude Design lên. Nếu là tài khoản cá nhân (Pro/Max) bạn tự bật được; nếu tài khoản trường/công ty mà không thấy bật được → cần admin bật giúp.
3. Vào được rồi bạn sẽ thấy **màn chia đôi**: bên trái là ô chat, bên phải là canvas (khung vẽ) còn trống.

### Bước 2.2 — Tạo project mới
- Bấm **New / Tạo mới**. Đặt tên gì cũng được, ví dụ "Finance App UI".

### Bước 2.3 — Nạp nguyên liệu
Trong ô chat bên trái:
1. **Đính kèm** (nút kẹp giấy 📎) → chọn `UI-DESIGN-SPEC.md` + mấy ảnh đã chuẩn bị.
2. **Dán prompt**: mở file `claude-design-prompt.md`, copy đúng đoạn từ dòng `=== BẮT ĐẦU ===` tới `=== KẾT THÚC ===`, dán vào ô chat.
3. Bấm gửi.

### Bước 2.4 — Chờ nó vẽ
- Nó sẽ dựng **màn Nhà (Dashboard)** trước ở canvas bên phải.
- Có thể nó hỏi lại vài câu cho rõ (ví dụ "bạn muốn nền sáng hay tối trước?") — cứ trả lời tự nhiên bằng tiếng Việt.

---

## Phần 3 — Chỉnh sửa cho tới khi ưng

Đây là phần vui nhất. Bạn tinh chỉnh bằng cách **nói chuyện**, không cần biết code. Vài cách:

**Cách 1 — Gõ yêu cầu trong chat** (dễ nhất cho người mới):
- "Làm số dư to hơn nữa."
- "Đổi màu tím đậm hơn một chút."
- "Cái dải kỳ (2 thanh) cho gần nhau lại để thấy rõ khoảng cách."
- "Cho tôi xem bản dark mode."
- "Chưa ưng, thử một bố cục khác đi."

**Cách 2 — Bấm thẳng lên phần tử trên canvas** (comment inline):
- Click vào chỗ muốn sửa → gõ ghi chú → nó sửa đúng chỗ đó.

**Cách 3 — Kéo/chỉnh trực tiếp**: kéo, đổi cỡ, canh lề, dùng thanh trượt (slider) nó tự tạo cho màu/khoảng cách.

> Mẹo người mới: **sửa từng thứ một, mỗi lần một yêu cầu.** Đừng bảo "sửa 10 thứ cùng lúc" — khó kiểm soát. Ưng màn Nhà rồi mới bảo: *"Giờ dựng màn Nhập theo cùng phong cách này."*

Cứ lặp lại tới khi bạn thấy đẹp. Không có giới hạn số lần sửa.

---

## Phần 4 — Bàn giao sang Claude Code (Handoff)

Khi đã ưng giao diện:

### Bước 4.1 — Tìm nút Handoff
- Trong Claude Design, tìm menu **Export / Share** (thường góc trên phải) → chọn **"Handoff to Claude Code"** (Bàn giao sang Claude Code).
- Nó sẽ **đóng gói** toàn bộ thiết kế thành một "bundle" (gói) + một câu lệnh sẵn.

### Bước 4.2 — Mở Claude Code
- Sang cửa sổ Claude Code (chỗ bạn đang mở repo `quan-ly-tai-chinh`).
- **Dán bundle/câu lệnh** mà Design đưa cho vào ô chat của Claude Code.

### Bước 4.3 — Ra lệnh ghép vào app thật
Gõ thêm cho Claude Code một câu rõ ràng, ví dụ:

> "Đây là thiết kế UI mới từ Claude Design cho màn Nhà và Nhập. Hãy đọc `CLAUDE.md` và `docs/UI-DESIGN-SPEC.md` trước. Ghép thiết kế này vào bản `sheet-lite/` — giữ nguyên cấu trúc nhiều file (`core.js`/`views.js`/`app.js`), plain `<script src>` không ES module, chạy được qua `file://`. Đừng đụng logic backend `Code.gs`. Làm từng màn một, báo cáo sau mỗi màn."

### Bước 4.4 — Claude Code build
- Nó sẽ chỉnh `app.css`, `views.js`... theo thiết kế mới.
- Nó báo đã sửa file nào. Bạn xem lại, chạy thử.

---

## Phần 5 — Luồng tổng thể (bức tranh lớn)

```
        PHÒNG VẼ                          THỢ XÂY
     (Claude Design)                   (Claude Code)
   ┌────────────────┐               ┌──────────────────┐
   │ spec + ảnh     │               │  repo thật       │
   │      ↓         │               │  quan-ly-tai-chinh│
   │  vẽ màn Nhà    │               │                  │
   │      ↓         │   Handoff     │  ghép UI mới vào │
   │  sửa tới đẹp   │ ────────────► │  sheet-lite/     │
   │      ↓         │   (1 nút)     │      ↓           │
   │  vẽ màn Nhập   │               │  chạy thử, xong  │
   └────────────────┘               └──────────────────┘

   Song song, KHÔNG cần chờ nhau:
   Claude Code cũng đang vá lỗi app hiện tại (dùng claude-code-brief.md):
   nút X chết · ngày/giờ sai · tràn khung · nhảy về đầu · parse 1tr
```

**2 luồng chạy song song:**
- **Luồng vá lỗi** (Claude Code + `claude-code-brief.md`): sửa app đang chạy. Làm bất cứ lúc nào.
- **Luồng thiết kế** (Claude Design + spec): vẽ giao diện mới. Xong thì handoff.

Chúng gặp nhau khi bạn handoff. Không cái nào phải chờ cái nào.

---

## Phần 6 — Câu hỏi hay gặp (người mới)

**Q: Vẽ ở Design có làm hỏng app thật không?**
Không. Design chỉ vẽ hình, hoàn toàn tách biệt. Chỉ khi bạn chủ động handoff + bảo Claude Code build thì code thật mới đổi.

**Q: Tôi lỡ tay bảo Code build sai thì sao?**
App bạn dùng `git` (branch `main`). Trước khi build, bảo Claude Code: *"tạo branch mới trước khi sửa"* — sai thì bỏ branch, `main` vẫn nguyên.

**Q: Phải làm cả 5 màn ở Design cùng lúc không?**
Không. Làm 2 màn Nhà + Nhập trước (dùng mỗi ngày). Ưng rồi mở rộng dần.

**Q: Design với Code có tự đồng bộ không?**
Không tự động. Bạn là người bấm handoff. Nghĩ đơn giản: bạn là người mang bản vẽ từ phòng vẽ sang cho thợ xây.

**Q: Tôi vẽ xong nhưng chưa muốn build ngay?**
Được. Cứ lưu project trong Design, hôm khác quay lại handoff cũng được.

---

## Phần 7 — Việc cần làm NGAY (tóm gọn)

1. Chép `UI-DESIGN-SPEC.md` (và mấy file kia) vào thư mục `docs/` trong repo, commit lên `main`.
2. Mở **claude.ai/design** → tạo project → đính kèm spec + ảnh → dán prompt → để nó vẽ màn Nhà.
3. Sửa tới khi ưng → vẽ tiếp màn Nhập.
4. **Handoff to Claude Code** → dán vào Claude Code → bảo nó ghép vào `sheet-lite/`.
5. Song song: dán `claude-code-brief.md` cho Claude Code vá lỗi app hiện tại.

Từ từ, mỗi lần một bước. Không cần vội.
