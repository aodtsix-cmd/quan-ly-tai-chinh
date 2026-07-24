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

# Note labels seen across real screenshots (2026-07-24): MoMo's receipt screen
# uses "Tin nhắn", MoMo's detail screen uses "Lời nhắn" for an incoming payment,
# and MB Bank's transaction-history lookup labels it "Nội dung" (though the
# value there is bank-generated boilerplate with the real note embedded — see
# _clean_mb_noi_dung). Matched via startswith on the (stripped) line, not a
# substring search — MoMo's own "Ghi chú | Nhập nội dung" placeholder row
# contains "nội dung" as part of its *value*, not as a label, and a substring
# search wrongly matched that before this was made startswith-only.
NOTE_LABELS = ("tin nhắn", "tin nhan", "lời nhắn", "loi nhan", "nội dung", "noi dung")

# MB's "Chuyển tiền thành công" confirmation screen doesn't label its note at
# all — it's just the last line of the details box before this fixed footer.
NOTE_BEFORE_FOOTER_MARKERS = ("cảm ơn bạn đã sử dụng", "cam on ban da su dung")

# Fallback for when OCR drops the note's label entirely (confirmed real case,
# 2026-07-24: MoMo's "Lời nhắn" label wasn't read at all by Tesseract — likely
# an icon or spacing issue — leaving "tien gui xe" as a bare, unlabeled line
# with no footer marker either). The user types notes without Vietnamese
# diacritics in every real sample seen, while the surrounding app UI text
# (statuses, bank names, labels) almost always has them — so a line with no
# diacritics that also isn't ALL-CAPS (which would make it a name/account
# label instead, e.g. "NGUYEN PHUC THANH") is a reasonable last-resort guess
# for the note.
_DIACRITIC_CHARS = set(
    "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
)

# Confirmed real case (2026-07-24): a checkmark/icon next to the headline
# amount got misread as "{sy" on the *same line* as "5,000 VND", and because
# text on the amount's own line is normally trusted as an inline note (that's
# correct for the history-list-row shape), "{sy" was wrongly saved as the
# note ahead of the real, correctly-found labeled/footer note. These symbols
# essentially never appear in real Vietnamese/English prose or in a typed
# transfer note, so their presence marks a line as OCR noise rather than text.
_JUNK_CHARS = set("{}<>|¬©®™§¶•·^~`»«‹›")


def _looks_like_real_note(candidate):
    candidate = candidate.strip()
    if not candidate:
        return False
    if any(ch in _JUNK_CHARS for ch in candidate):
        return False
    return sum(ch.isalpha() for ch in candidate) >= 3


def _find_ascii_lowercase_note(lines):
    for line in lines:
        lower = line.lower()
        if any(ch in _DIACRITIC_CHARS for ch in lower):
            continue
        if not re.search(r"[a-z]", line):  # no lowercase letter ⇒ likely a code/name, not typed prose
            continue
        if len(line.split()) < 2:
            continue
        if AMOUNT_PATTERN.search(line):
            continue
        if not _looks_like_real_note(line):
            continue
        return line
    return None


# Neither app's screens reliably show a plain +/- next to the amount (MoMo's
# receipt/confirmation screen doesn't; MoMo's "Chi tiết giao dịch" detail
# screen and MB's dark transaction-lookup modal sometimes do, sometimes just
# say "Chuyển khoản đến/từ" which is too ambiguous to parse with confidence
# from 1-2 samples). When there's no sign on the matched amount itself, fall
# back to a keyword guess; default "out" since most screenshots so far were
# outgoing transfers.
INCOMING_KEYWORDS = ("nhận tiền", "nhan tien", "tiền vào", "tien vao")


def extract_text(image_file):
    """image_file: a file path or file-like object (e.g. Flask's FileStorage.stream).
    Returns raw OCR text. Requires the `tesseract` binary to be installed
    (`brew install tesseract tesseract-lang` on macOS)."""
    image = Image.open(image_file)
    return pytesseract.image_to_string(image, lang="vie+eng")


def _clean_mb_noi_dung(value):
    """MB Bank's 'Nội dung' field on a transaction-history lookup embeds the
    user's actual note inside bank/merchant-generated boilerplate. Best-effort
    cleanup based on the two shapes seen in real samples so far:

      "CUSTOMER MBCT {note} {REF8CHARS}/{digits}"
      "{merchant text} {txid}-{note}-CHUYEN TIEN-{code}-MOMO{id}MOMO. TU: ..."

    Falls back to returning `value` unchanged if neither shape matches —
    better to hand the user the full messy string to trim themselves than to
    guess wrong and silently drop part of a real note."""
    prefix = "CUSTOMER MBCT "
    if value.upper().startswith(prefix):
        rest = value[len(prefix):].strip()
        rest = re.sub(r"\s+[A-Z0-9]{6,}/\d+$", "", rest)
        return rest.strip() or value

    if "-CHUYEN TIEN-" in value.upper():
        parts = value.split("-")
        if len(parts) >= 3 and parts[1].strip():
            return parts[1].strip()

    return value


def _find_labeled_note(lines):
    for i, line in enumerate(lines):
        lower = line.lower()
        for label in NOTE_LABELS:
            if not lower.startswith(label):
                continue
            remainder = line[len(label):].strip(" :\t")
            if not remainder and i + 1 < len(lines):
                remainder = lines[i + 1].strip()
            if not remainder:
                continue
            if label in ("nội dung", "noi dung"):
                remainder = _clean_mb_noi_dung(remainder)
            return remainder
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
    """Best-effort, first-pass parser covering the real screenshot shapes seen
    so far (all single-transaction receipt/detail/confirmation screens, not a
    scrolling multi-row history list as originally assumed):

    1. A compact row with amount and note on the same line (e.g.
       "-50.000đ Cà phê Highlands") — still supported in case a real
       history-list screenshot does turn up.
    2. A receipt/confirmation/detail screen where the amount stands alone and
       the note is elsewhere — found via `_find_labeled_note` (MoMo's "Tin
       nhắn"/"Lời nhắn", MB's "Nội dung") or `_find_note_before_footer` (MB's
       unlabeled confirmation-screen note).

    These detail/confirmation screens often restate the same amount twice
    (a large headline figure plus a labeled "Số tiền"/"Số tiền ghi nhận" field
    further down) — deduplicated below by (amount, direction) so one
    screenshot doesn't produce two candidates for the same transfer.

    Still a first pass, tuned only against the real samples seen so far (two
    MoMo screens, three MB Bank screens, 2026-07-24) — this exists to be
    corrected by the user in the import-review screen before anything is
    saved, not to be trusted on its own."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    labeled_note = _find_labeled_note(lines)
    footer_note = _find_note_before_footer(lines)
    ascii_note = _find_ascii_lowercase_note(lines)
    whole_text_lower = text.lower()

    candidates = []
    seen = set()
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

        key = (amount, direction)
        if key in seen:
            continue
        seen.add(key)

        inline_note = (line[:match.start()] + " " + line[match.end():]).strip()
        if not _looks_like_real_note(inline_note):
            inline_note = ""
        note = inline_note or labeled_note or footer_note or ascii_note or line

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
