"""Single shared entry point for every AI-generated recommendation/explanation
in the app (budget suggestions, goal prioritization, spending-simulation
advice, seasonality explanations, macro-context summaries, daily summaries).

Deliberately NOT used by ocr_import.py's analyze_image() — that call is a
structurally different task (multimodal image extraction feeding a mandatory
human review step, no sensible cache key since every screenshot is unique)
where a network failure must surface as a visible error, not be swallowed
into "gently unavailable, page still works". ocr_import.py does reuse this
module's get_client() and log_call() so all real API usage still lands in
one place (ai_calls), without forcing OCR into a caching contract that
doesn't fit it.

Every function here is designed to NEVER raise — any failure (missing key,
network error, quota, malformed response) is caught and turned into
{"available": False, "reason": ..., "data": None}, so a page that calls this
can always render its Python-computed numbers even if Gemini is completely
unreachable (relevant for PythonAnywhere's free-tier outbound allowlist,
which may block Gemini's domain entirely — unconfirmed until tested live)."""

import hashlib
import json
import os
from datetime import datetime, timedelta

from google import genai
from google.genai import types

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"
DEFAULT_MODEL_HEAVY = os.environ.get("GEMINI_MODEL_HEAVY") or "gemini-pro-latest"
DEFAULT_TTL_SECONDS = 6 * 60 * 60  # 6 hours — long enough to avoid refetching on every page load

_client = None


def get_client():
    """Shared genai.Client singleton — also used directly by ocr_import.py so
    there's exactly one place that reads GEMINI_API_KEY and constructs a client."""
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


def log_call(cursor, *, task, model, success, prompt_tokens=None,
             response_tokens=None, total_tokens=None, error_message=None):
    """Records one real API attempt (success or failure) to ai_calls. Not
    called for cache hits — a cache hit makes no API call and uses no
    tokens, so logging it here would misrepresent what this table tracks."""
    cursor.execute(
        """INSERT INTO ai_calls
           (task, model, success, prompt_tokens, response_tokens, total_tokens, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (task, model, int(success), prompt_tokens, response_tokens, total_tokens, error_message),
    )


def _hash_input(task, input_data):
    payload = {"task": task, **input_data}
    serialized = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _classify_error(exc):
    """Heuristic only (the genai SDK doesn't expose a clean, stable exception
    taxonomy to match against) — good enough to pick a gentler user-facing
    message, not meant to be a precise diagnosis."""
    message = str(exc).lower()
    if isinstance(exc, (ValueError, TypeError)):
        return "invalid_response"
    if "quota" in message or "rate limit" in message or "429" in message or "resource_exhausted" in message:
        return "quota"
    if "timeout" in message or "timed out" in message or "deadline" in message:
        return "timeout"
    return "network"


def get_ai_suggestion(cursor, *, task, input_data, response_schema, prompt,
                       model=None, ttl_seconds=DEFAULT_TTL_SECONDS):
    """Runs one AI task, transparently cached by (task, hash of input_data).

    Never raises. Returns one of:
      {"available": True,  "data": <dict>, "cached": bool}
      {"available": False, "reason": "no_key"|"quota"|"timeout"|"invalid_response"|"network", "data": None}

    `response_schema` is a Pydantic model class — Gemini is forced to return
    JSON matching it (response_mime_type="application/json"), never parsed
    from free text, per the app's standing rule that AI never computes money:
    `input_data` must already contain every number this task needs, computed
    by plain Python beforehand.

    Doesn't commit the cursor's connection — same convention as the rest of
    this codebase (insert_transaction, add_rule, ...): the caller commits."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"available": False, "reason": "no_key", "data": None}

    model_name = model or DEFAULT_MODEL
    input_hash = _hash_input(task, input_data)

    cursor.execute(
        """SELECT response FROM ai_cache
           WHERE task = ? AND input_hash = ? AND expires_at > datetime('now')""",
        (task, input_hash),
    )
    row = cursor.fetchone()
    if row is not None:
        return {"available": True, "data": json.loads(row["response"]), "cached": True}

    try:
        client = get_client()
        response = client.models.generate_content(
            model=model_name,
            contents=[prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=response_schema,
            ),
        )
        parsed = response_schema.model_validate_json(response.text)
        data = parsed.model_dump(mode="json")
        usage = getattr(response, "usage_metadata", None)
        log_call(
            cursor, task=task, model=model_name, success=True,
            prompt_tokens=getattr(usage, "prompt_token_count", None) if usage else None,
            response_tokens=getattr(usage, "candidates_token_count", None) if usage else None,
            total_tokens=getattr(usage, "total_token_count", None) if usage else None,
        )
    except Exception as exc:
        log_call(cursor, task=task, model=model_name, success=False, error_message=str(exc))
        return {"available": False, "reason": _classify_error(exc), "data": None}

    expires_at = (datetime.now() + timedelta(seconds=ttl_seconds)).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        """INSERT INTO ai_cache (task, input_hash, response, model, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (task, input_hash) DO UPDATE SET
             response = excluded.response, model = excluded.model,
             created_at = datetime('now'), expires_at = excluded.expires_at""",
        (task, input_hash, json.dumps(data), model_name, expires_at),
    )
    return {"available": True, "data": data, "cached": False}
