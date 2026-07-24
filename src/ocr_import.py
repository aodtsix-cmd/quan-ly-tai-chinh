import hashlib
import re

import pytesseract
from PIL import Image

# Matches VND amounts written with thousand separators, e.g. "-50.000", "+1,200,000",
# "50.000đ" (MoMo style: period separator, đ suffix), "5,000 VND" (MB Bank style:
# comma separator, "VND" suffix — matched case-insensitively against "vnd").
AMOUNT_PATTERN = re.compile(r"([+-]?\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|d|vnd)?", re.IGNORECASE)
MIN_AMOUNT = 1000  # filters out obvious non-money matches (dates, phone digits, ...)

# Lines containing these are a running/current balance, not a transaction —
# e.g. "Số dư: 4.950.000đ" caused a false-positive candidate in testing before
# this filter was added. Extend this list as more non-transaction line types
# turn up once tested against real screenshots.
NON_TRANSACTION_KEYWORDS = ("số dư", "so du", "balance")

# MoMo's transaction-receipt screen explicitly labels the note field ("Tin nhắn").
# MB Bank's confirmation screen does not label it at all — it's just the last
# line of the details box before MB's fixed thank-you footer, so it's found via
# NOTE_BEFORE_FOOTER_MARKERS instead. Both confirmed against real screenshots
# (2026-07-24): a MoMo "Kết quả giao dịch" receipt and an MB "Chuyển tiền thành
# công" confirmation.
NOTE_LABELS = ("tin nhắn", "tin nhan", "nội dung", "noi dung", "lời nhắn", "loi nhan")
NOTE_BEFORE_FOOTER_MARKERS = ("cảm ơn bạn đã sử dụng", "cam on ban da su dung")

# No explicit "chi/thu" or +/- indicator on either app's confirmation screen —
# direction has to be guessed from wording. Both real samples seen so far were
# outgoing transfers, so "out" is the default when no keyword matches.
INCOMING_KEYWORDS = ("nhận tiền", "nhan tien", "tiền vào", "tien vao")


def extract_text(image_file):
    """image_file: a file path or file-like object (e.g. Flask's FileStorage.stream).
    Returns raw OCR text. Requires the `tesseract` binary to be installed
    (`brew install tesseract tesseract-lang` on macOS)."""
    image = Image.open(image_file)
    return pytesseract.image_to_string(image, lang="vie+eng")


def _find_labeled_note(lines):
    for i, line in enumerate(lines):
        lower = line.lower()
        for label in NOTE_LABELS:
            idx = lower.find(label)
            if idx == -1:
                continue
            remainder = line[idx + len(label):].strip(" :\t")
            if remainder:
                return remainder
            if i + 1 < len(lines):
                return lines[i + 1].strip()
    return None


def _find_note_before_footer(lines):
    for i, line in enumerate(lines):
        lower = line.lower()
        if any(marker in lower for marker in NOTE_BEFORE_FOOTER_MARKERS) and i > 0:
            return lines[i - 1].strip()
    return None


def _guess_direction(sign_prefix, whole_text_lower):
    if sign_prefix == "+":
        return "in"
    if sign_prefix == "-":
        return "out"
    if any(keyword in whole_text_lower for keyword in INCOMING_KEYWORDS):
        return "in"
    return "out"


def parse_candidates(text):
    """Best-effort, first-pass parser covering two known real screenshot shapes:

    1. A compact transaction-history row with the amount and note on the same
       line (e.g. "-50.000đ Cà phê Highlands") — note is whatever's left on
       that line after removing the matched amount.
    2. A single-transaction receipt/confirmation screen (MoMo "Kết quả giao
       dịch", MB "Chuyển tiền thành công") where the amount stands alone on
       its own line and the note is elsewhere — found via `_find_labeled_note`
       (MoMo's explicit "Tin nhắn" label) or `_find_note_before_footer` (MB's
       unlabeled note, which sits right before its fixed thank-you footer).

    Still a first pass: only tuned against the two real samples seen so far
    (one MoMo, one MB). Expect to keep adjusting as more screenshot shapes
    turn up — this exists to be corrected by the user in the import-review
    screen before anything is saved, not to be trusted on its own."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    labeled_note = _find_labeled_note(lines)
    footer_note = _find_note_before_footer(lines)
    whole_text_lower = text.lower()

    candidates = []
    for line in lines:
        if any(keyword in line.lower() for keyword in NON_TRANSACTION_KEYWORDS):
            continue
        match = AMOUNT_PATTERN.search(line)
        if not match:
            continue

        raw_amount = match.group(1).replace(".", "").replace(",", "").lstrip("+-")
        try:
            amount = int(raw_amount)
        except ValueError:
            continue
        if amount < MIN_AMOUNT:
            continue

        sign_prefix = "+" if match.group(1).strip().startswith("+") else (
            "-" if match.group(1).strip().startswith("-") else ""
        )
        direction = _guess_direction(sign_prefix, whole_text_lower)

        inline_note = (line[:match.start()] + " " + line[match.end():]).strip()
        note = inline_note or labeled_note or footer_note or line

        candidates.append({
            "raw_line": line,
            "amount": amount,
            "direction": direction,
            "note": note,
        })
    return candidates


def make_external_ref(amount, direction, note):
    """A dedupe key for OCR-derived transactions, since there's no bank
    reference number to key off. Same (amount, direction, note) → same key,
    so re-importing the same screenshot twice is caught by the `external_ref`
    UNIQUE constraint rather than silently duplicating the transaction."""
    digest = hashlib.sha1(f"{amount}|{direction}|{note}".encode("utf-8")).hexdigest()
    return f"ocr:{digest[:16]}"
