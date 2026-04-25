from __future__ import annotations

import os
from typing import Any

from . import client, ingest

_EXCERPT_CAP = 600


def _normalize_for_compare(text: str) -> str:
    return " ".join(text.split()).strip()


async def fetch_prior_memories(section_text: str) -> list[dict[str, Any]]:
    """Semantic hits from Backboard for the current proxy session (canonical slots only)."""
    if not client.is_configured() or not section_text.strip():
        return []
    sid = ingest.get_session_id()
    if not sid:
        return []
    user_key = ingest.get_user_key()
    conversation_id = ingest.get_conversation_id()
    try:
        limit = int(os.getenv("BACKBOARD_SEARCH_LIMIT", "5"))
    except ValueError:
        limit = 5
    rows = await client.search_memories(query=section_text[:5000], limit=limit)
    norm_section = _normalize_for_compare(section_text)
    out: list[dict[str, Any]] = []
    for m in rows:
        md = m.get("metadata")
        if not isinstance(md, dict):
            md = {}
        if md.get("deleted") is True:
            continue
        if md.get("kind") != "canonical_message":
            continue
        if md.get("user_key") != user_key or md.get("conversation_id") != conversation_id:
            continue
        if md.get("session_id") != sid:
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        excerpt = content.strip()
        if _normalize_for_compare(excerpt) == norm_section:
            continue
        if len(excerpt) > _EXCERPT_CAP:
            excerpt = excerpt[:_EXCERPT_CAP] + "…"
        score = m.get("score")
        try:
            score_f = float(score) if score is not None else None
        except (TypeError, ValueError):
            score_f = None
        out.append({"score": score_f, "excerpt": excerpt})
    return out
