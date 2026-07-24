"""Extracts transaction candidates from a screenshot using the Gemini API's
image understanding, instead of local Tesseract OCR + regex line-parsing
(the original approach). Switched after Tesseract repeatedly misread real
screenshots in ways plain regex couldn't recover from — garbled/dropped
labels, and a two-column layout sometimes read as "all labels, then all
values" instead of label-value pairs in order — each requiring a new,
increasingly fragile heuristic. A vision model reads the screen semantically
instead of line-by-line, so it isn't tripped up by OCR reading order.

Also asks Gemini to suggest a category directly from the note's meaning
(e.g. "tien an trua" → an eating-out category) — a semantic guess, broader
than the substring-matching `rules` engine in transaction.py, which only
fires on an exact known keyword. Both still land in the same editable
review screen before anything is saved, so a wrong guess either way costs
the user one dropdown click, not bad data.

Requires GEMINI_API_KEY in the environment (get one free at
https://aistudio.google.com/apikey). Images are sent to Google's API for
this — a deliberate trade of the "everything stays local" property the
Tesseract approach had, made explicitly by the user after Tesseract's
accuracy problems proved hard to fix with more regex patches."""

import hashlib
import os

from google import genai
from google.genai import types
from pydantic import BaseModel, Field

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")

_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Chưa đặt biến môi trường GEMINI_API_KEY. "
                "Tạo API key miễn phí tại https://aistudio.google.com/apikey"
            )
        _client = genai.Client(api_key=api_key)
    return _client


class _Candidate(BaseModel):
    amount: int = Field(description="Số tiền giao dịch, chỉ ghi số nguyên VNĐ, không có dấu phẩy/chấm/đơn vị")
    direction: str = Field(description='"out" nếu là tiền chuyển đi/chi tiêu, "in" nếu là tiền nhận được')
    note: str = Field(description="Ghi chú/tin nhắn người dùng tự gõ khi chuyển tiền, hoặc chuỗi rỗng nếu không có")
    category_id: int | None = Field(
        description="id của danh mục phù hợp nhất với ghi chú, chọn đúng 1 trong danh sách id đã cho ở trên "
        "(đúng theo hướng chi/thu). Để null nếu không đủ căn cứ để đoán, đừng chọn bừa."
    )


class _AnalysisResult(BaseModel):
    transactions: list[_Candidate]


BASE_PROMPT = """Đây là ảnh chụp màn hình xác nhận/chi tiết một giao dịch chuyển
tiền từ ứng dụng ngân hàng hoặc ví điện tử Việt Nam (MB Bank, MoMo, ...).

Hãy đọc và trích xuất TỪNG giao dịch chuyển tiền THỰC SỰ xuất hiện trong ảnh
(thường chỉ có 1 giao dịch trên một ảnh, nhưng có thể nhiều nếu đây là một
danh sách lịch sử nhiều dòng).

Với mỗi giao dịch, xác định:
- amount: số tiền, chỉ ghi số nguyên VNĐ (vd 50000), không có dấu phẩy/chấm/đơn vị.
- direction: "out" nếu là tiền chuyển đi/chi tiêu, "in" nếu là tiền nhận được.
- note: PHẦN GHI CHÚ/TIN NHẮN mà chính người dùng đã tự gõ khi chuyển tiền
  (ví dụ "tien gui xe", "an trua", "tra tien nha"). TUYỆT ĐỐI không lấy tên
  người nhận/người gửi, tên ngân hàng, mã giao dịch, hay các đoạn mã hệ
  thống ngân hàng tự sinh ra (ví dụ những chuỗi dạng "CUSTOMER MBCT...",
  "...CHUYEN TIEN...", các mã tham chiếu dài xen kẽ chữ và số). Nếu nội
  dung hệ thống trộn lẫn ghi chú người dùng ở giữa một chuỗi dài, chỉ lấy
  đúng phần ghi chú đó, bỏ phần còn lại. Nếu không tìm thấy ghi chú nào, để
  note là chuỗi rỗng.
- category_id: dựa vào Ý NGHĨA của ghi chú (không chỉ khớp từ khóa), đoán
  giao dịch này thuộc danh mục nào trong danh sách dưới đây, rồi trả về
  đúng "id" số nguyên của danh mục đó. Ví dụ ghi chú "an trua"/"tien com"
  hợp lý thuộc danh mục ăn uống; "gui xe"/"gửi xe" hợp lý thuộc danh mục
  di chuyển/gửi xe. Chỉ chọn trong danh sách id đã cho, đúng theo hướng
  (giao dịch "out" phải chọn id thuộc nhóm Chi tiêu, "in" phải chọn id
  thuộc nhóm Thu nhập). Nếu ghi chú quá mơ hồ để đoán chắc chắn, để
  category_id là null.

Đừng tính các dòng chỉ hiển thị số dư tài khoản hiện tại (không phải một
giao dịch cụ thể). Nếu cùng một giao dịch có số tiền bị hiển thị lặp lại
nhiều lần trên ảnh (vd số tiền lớn ở đầu và nhắc lại ở một dòng "Số tiền"
phía dưới), chỉ tính đó là MỘT giao dịch, không tách thành hai.

Danh sách danh mục có thể chọn cho category_id:
{categories_text}"""


def _format_categories(categories_by_kind):
    kind_labels = {"expense": "Chi tiêu", "income": "Thu nhập"}
    lines = []
    for kind, label in kind_labels.items():
        lines.append(f"{label}:")
        for parent in categories_by_kind.get(kind, []):
            if parent["children"]:
                for child in parent["children"]:
                    lines.append(f"  id={child['id']}: {child['name']} (thuộc {parent['name']})")
            else:
                lines.append(f"  id={parent['id']}: {parent['name']}")
    return "\n".join(lines)


def analyze_image(image_bytes, mime_type, categories_by_kind):
    """Sends one screenshot to Gemini and returns a list of
    {"amount": int, "direction": "in"/"out", "note": str, "category_id": int|None}
    — one per real transaction found (almost always exactly one).

    `categories_by_kind` is {"expense": [...], "income": [...]}, each a list
    of {"id", "name", "children": [...]}} as built by web_app.py's
    category_tree_as_json — given to Gemini so it can suggest a category id
    directly, and used here afterward to reject any id it returns that isn't
    actually a real category (never trust a model-generated foreign key
    blindly, even for a low-stakes field like this).

    Raises RuntimeError if GEMINI_API_KEY isn't set, or lets the underlying
    API exception propagate on request failure (network error, invalid key,
    quota, ...) — the caller is expected to catch and show a friendly
    message, same as the old Tesseract path did for OCR failures."""
    valid_category_ids = set()
    for parents in categories_by_kind.values():
        for parent in parents:
            valid_category_ids.add(parent["id"])
            for child in parent["children"]:
                valid_category_ids.add(child["id"])

    prompt = BASE_PROMPT.format(categories_text=_format_categories(categories_by_kind))

    client = _get_client()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[
            prompt,
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_AnalysisResult,
        ),
    )
    result = _AnalysisResult.model_validate_json(response.text)

    candidates = []
    seen = set()
    for tx in result.transactions:
        if tx.direction not in ("in", "out") or tx.amount <= 0:
            continue
        key = (tx.amount, tx.direction)
        if key in seen:
            continue
        seen.add(key)
        category_id = tx.category_id if tx.category_id in valid_category_ids else None
        candidates.append({
            "amount": tx.amount,
            "direction": tx.direction,
            "note": tx.note.strip(),
            "category_id": category_id,
        })
    return candidates


def make_external_ref(amount, direction, note):
    """A dedupe key for OCR-derived transactions, since there's no bank
    reference number to key off. Same (amount, direction, note) → same key,
    so re-importing the same screenshot twice is caught by the `external_ref`
    UNIQUE constraint rather than silently duplicating the transaction."""
    digest = hashlib.sha1(f"{amount}|{direction}|{note}".encode("utf-8")).hexdigest()
    return f"ocr:{digest[:16]}"
