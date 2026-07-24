"""Extracts transaction candidates from a screenshot using the Gemini API's
image understanding, instead of local Tesseract OCR + regex line-parsing
(the original approach). Switched after Tesseract repeatedly misread real
screenshots in ways plain regex couldn't recover from — garbled/dropped
labels, and a two-column layout sometimes read as "all labels, then all
values" instead of label-value pairs in order — each requiring a new,
increasingly fragile heuristic. A vision model reads the screen semantically
instead of line-by-line, so it isn't tripped up by OCR reading order.

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

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

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


class _AnalysisResult(BaseModel):
    transactions: list[_Candidate]


PROMPT = """Đây là ảnh chụp màn hình xác nhận/chi tiết một giao dịch chuyển
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

Đừng tính các dòng chỉ hiển thị số dư tài khoản hiện tại (không phải một
giao dịch cụ thể). Nếu cùng một giao dịch có số tiền bị hiển thị lặp lại
nhiều lần trên ảnh (vd số tiền lớn ở đầu và nhắc lại ở một dòng "Số tiền"
phía dưới), chỉ tính đó là MỘT giao dịch, không tách thành hai."""


def analyze_image(image_bytes, mime_type="image/png"):
    """Sends one screenshot to Gemini and returns a list of
    {"amount": int, "direction": "in"/"out", "note": str} — one per real
    transaction found (almost always exactly one). Raises RuntimeError if
    GEMINI_API_KEY isn't set, or lets the underlying API exception propagate
    on request failure (network error, invalid key, quota, ...) — the caller
    is expected to catch and show a friendly message, same as the old
    Tesseract path did for OCR failures."""
    client = _get_client()
    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[
            PROMPT,
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
        candidates.append({"amount": tx.amount, "direction": tx.direction, "note": tx.note.strip()})
    return candidates


def make_external_ref(amount, direction, note):
    """A dedupe key for OCR-derived transactions, since there's no bank
    reference number to key off. Same (amount, direction, note) → same key,
    so re-importing the same screenshot twice is caught by the `external_ref`
    UNIQUE constraint rather than silently duplicating the transaction."""
    digest = hashlib.sha1(f"{amount}|{direction}|{note}".encode("utf-8")).hexdigest()
    return f"ocr:{digest[:16]}"
