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
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("gemma: malformed flagging JSON")
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
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("gemma: malformed suggestion JSON")
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
