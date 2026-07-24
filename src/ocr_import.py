import hashlib
import re

import pytesseract
from PIL import Image

# Matches VND amounts written with thousand separators, e.g. "-50.000", "+1,200,000", "50.000đ".
AMOUNT_PATTERN = re.compile(r"([+-]?\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|d|vnd)?", re.IGNORECASE)
MIN_AMOUNT = 1000  # filters out obvious non-money matches (dates, phone digits, ...)

# Lines containing these are a running/current balance, not a transaction —
# e.g. "Số dư: 4.950.000đ" caused a false-positive candidate in testing before
# this filter was added. Extend this list as more non-transaction line types
# turn up once tested against real screenshots.
NON_TRANSACTION_KEYWORDS = ("số dư", "so du", "balance")


def extract_text(image_file):
    """image_file: a file path or file-like object (e.g. Flask's FileStorage.stream).
    Returns raw OCR text. Requires the `tesseract` binary to be installed
    (`brew install tesseract tesseract-lang` on macOS)."""
    image = Image.open(image_file)
    return pytesseract.image_to_string(image, lang="vie+eng")


def parse_candidates(text):
    """Best-effort, first-pass line parser: for each line containing something
    that looks like a VND amount, extract amount/direction/note.

    This is intentionally rough — it exists to be reviewed and corrected by
    the user in the import-review screen before anything is saved, not to be
    trusted on its own. It has not been tuned against a real MoMo/MB Bank
    screenshot yet; expect to adjust AMOUNT_PATTERN once real samples are
    seen."""
    candidates = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
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

        direction = "in" if match.group(1).strip().startswith("+") else "out"
        note = (line[:match.start()] + " " + line[match.end():]).strip()

        candidates.append({
            "raw_line": line,
            "amount": amount,
            "direction": direction,
            "note": note or line,
        })
    return candidates


def make_external_ref(amount, direction, note):
    """A dedupe key for OCR-derived transactions, since there's no bank
    reference number to key off. Same (amount, direction, note) → same key,
    so re-importing the same screenshot twice is caught by the `external_ref`
    UNIQUE constraint rather than silently duplicating the transaction."""
    digest = hashlib.sha1(f"{amount}|{direction}|{note}".encode("utf-8")).hexdigest()
    return f"ocr:{digest[:16]}"
