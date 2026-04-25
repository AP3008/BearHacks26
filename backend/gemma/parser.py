from __future__ import annotations

import json
import logging
from typing import Any

from models import GemmaFlag, Highlight, SuggestionHighlight

logger = logging.getLogger(__name__)

_VALID_SEVERITY = {"high", "medium", "low"}


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_json_payload(raw: str) -> str:
    """Best-effort extraction of the first JSON object/array from a model reply.

    Models sometimes wrap JSON in code fences or preface it with text. Ollama's
    `format="json"` helps, but it's not a hard guarantee across all model builds.
    """
    text = raw.strip()
    if not text:
        return text

    # Strip ```json ... ``` fences if present.
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            # Drop the opening fence line and a trailing closing fence.
            inner = "\n".join(lines[1:-1]).strip()
            if inner:
                text = inner

    # If it already parses, keep it.
    try:
        json.loads(text)
        return text
    except Exception:
        pass

    # Extract first {...} or [...] block by bracket matching.
    start_obj = text.find("{")
    start_arr = text.find("[")
    if start_obj == -1 and start_arr == -1:
        return text
    start = start_obj if start_arr == -1 else start_arr if start_obj == -1 else min(start_obj, start_arr)
    opening = text[start]
    closing = "}" if opening == "{" else "]"

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == "\"":
                in_string = False
            continue
        else:
            if ch == "\"":
                in_string = True
                continue
            if ch == opening:
                depth += 1
            elif ch == closing:
                depth -= 1
                if depth == 0:
                    return text[start : i + 1].strip()
    return text


def _parse_highlights(raw: Any) -> list[Highlight]:
    out: list[Highlight] = []
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        start = _coerce_int(entry.get("start"))
        end = _coerce_int(entry.get("end"))
        if start is None or end is None:
            continue
        out.append(Highlight(start=start, end=end))
    return out


def parse_flags(raw: str) -> list[GemmaFlag]:
    payload = _extract_json_payload(raw)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        preview = payload.strip().replace("\n", "\\n")[:400]
        logger.warning("gemma: malformed flagging JSON payload=%s", preview)
        return []

    if isinstance(data, dict) and isinstance(data.get("flags"), list):
        entries = data["flags"]
    elif isinstance(data, list):
        entries = data
    else:
        logger.warning("gemma: flagging JSON has unexpected shape")
        return []

    flags: list[GemmaFlag] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        idx = _coerce_int(entry.get("sectionIndex"))
        severity = entry.get("severity")
        reason = entry.get("reason")
        if idx is None or severity not in _VALID_SEVERITY or not isinstance(reason, str):
            continue
        flags.append(
            GemmaFlag(
                sectionIndex=idx,
                severity=severity,
                reason=reason,
                highlights=_parse_highlights(entry.get("highlights", [])),
            )
        )
    return flags


def parse_suggestion(raw: str) -> list[SuggestionHighlight]:
    payload = _extract_json_payload(raw)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        preview = payload.strip().replace("\n", "\\n")[:400]
        logger.warning("gemma: malformed suggestion JSON payload=%s", preview)
        return []

    if isinstance(data, dict) and isinstance(data.get("highlights"), list):
        entries = data["highlights"]
    elif isinstance(data, list):
        entries = data
    else:
        return []

    out: list[SuggestionHighlight] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        start = _coerce_int(entry.get("start"))
        end = _coerce_int(entry.get("end"))
        reason = entry.get("reason", "")
        if start is None or end is None or not isinstance(reason, str):
            continue
        out.append(SuggestionHighlight(start=start, end=end, reason=reason))
    return out
