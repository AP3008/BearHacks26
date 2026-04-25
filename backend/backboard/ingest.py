from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any

import classifier
from models import EditedSection

from . import client
from .keys import slot_message_key

logger = logging.getLogger(__name__)

_memory_id_by_key: dict[str, str] = {}
_session_id: str = ""
_ingest_lock = asyncio.Lock()


def get_session_id() -> str:
    return _session_id


def rotate_session() -> None:
    """New proxy-side session namespace (Claude restart or explicit reset)."""
    global _session_id, _memory_id_by_key
    _session_id = uuid.uuid4().hex
    _memory_id_by_key = {}
    logger.info("backboard: new session_id=%s", _session_id[:12] + "…")


def _content_cap() -> int:
    return int(os.getenv("BACKBOARD_CONTENT_CAP", "12000"))


def _raw_summary(body: dict[str, Any]) -> str:
    """Compact text extract for raw_incoming memories (not full JSON)."""
    msgs = body.get("messages") or []
    if not isinstance(msgs, list):
        return ""
    lines: list[str] = []
    for entry in msgs[-8:]:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role", "")
        content = entry.get("content")
        if isinstance(content, str):
            text = content.strip()
        elif isinstance(content, list):
            chunks: list[str] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    chunks.append(block["text"])
                elif block.get("type") == "tool_result":
                    inner = block.get("content")
                    if isinstance(inner, str):
                        chunks.append(inner)
            text = "\n".join(c for c in chunks if c).strip()
        else:
            text = ""
        if text:
            flat = " ".join(text.split())
            lines.append(f"{role}: {flat[:2000]}")
    out = "\n".join(lines)
    return out[:8000]


def _body_fingerprint(body: dict[str, Any]) -> str:
    try:
        raw = json.dumps(body, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):
        raw = str(body)
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:32]


async def _tombstone_key(message_key: str) -> None:
    memory_id = _memory_id_by_key.pop(message_key, None)
    if not memory_id:
        return
    ok = await client.update_memory(
        memory_id=memory_id,
        content="[removed]",
        metadata={
            "session_id": _session_id,
            "message_key": message_key,
            "kind": "canonical_message",
            "deleted": True,
        },
    )
    if not ok:
        logger.warning("backboard: tombstone failed message_key=%s", message_key[:16])


async def _add_canonical_slot(
    *,
    index: int,
    section_type: str,
    raw_text: str,
    request_id: str,
) -> None:
    message_key = slot_message_key(
        session_id=_session_id,
        index=index,
        section_type=section_type,
        raw_content=raw_text,
    )
    if message_key in _memory_id_by_key:
        return
    cap = _content_cap()
    text = raw_text if len(raw_text) <= cap else raw_text[:cap] + "\n…[truncated]"
    mid = await client.add_memory(
        content=text,
        metadata={
            "session_id": _session_id,
            "message_key": message_key,
            "kind": "canonical_message",
            "section_index": index,
            "section_type": section_type,
            "request_id": request_id,
            "deleted": False,
        },
    )
    if mid:
        _memory_id_by_key[message_key] = mid


async def _ingest_canonical_body(body: dict[str, Any], request_id: str) -> None:
    if not client.is_configured() or not _session_id:
        return
    sections, _, _, _ = classifier.classify(body)
    for s in sections:
        await _add_canonical_slot(
            index=s.index,
            section_type=s.sectionType,
            raw_text=s.rawContent,
            request_id=request_id,
        )


async def _ingest_raw_incoming(body: dict[str, Any], request_id: str) -> None:
    if not client.is_configured() or not _session_id:
        return
    summary = _raw_summary(body)
    if not summary.strip():
        return
    fp = _body_fingerprint(body)
    msgs = body.get("messages") or []
    msg_count = len(msgs) if isinstance(msgs, list) else 0
    await client.add_memory(
        content=summary,
        metadata={
            "session_id": _session_id,
            "kind": "raw_incoming",
            "request_id": request_id,
            "message_count": msg_count,
            "body_fp": fp,
            "deleted": False,
        },
    )


def schedule_raw_incoming(body: dict[str, Any], request_id: str) -> None:
    if not client.is_configured():
        return

    async def _run() -> None:
        try:
            async with _ingest_lock:
                await _ingest_raw_incoming(body, request_id)
        except Exception:
            logger.exception("backboard: raw_incoming ingest failed")

    asyncio.create_task(_run())


def schedule_canonical_synced(body: dict[str, Any], request_id: str) -> None:
    if not client.is_configured():
        return

    async def _run() -> None:
        try:
            async with _ingest_lock:
                await _ingest_canonical_body(body, request_id)
        except Exception:
            logger.exception("backboard: canonical ingest failed")

    asyncio.create_task(_run())


def _index_to_message_key(body: dict[str, Any]) -> dict[int, str]:
    sections, _, _, _ = classifier.classify(body)
    out: dict[int, str] = {}
    for s in sections:
        out[s.index] = slot_message_key(
            session_id=_session_id,
            index=s.index,
            section_type=s.sectionType,
            raw_content=s.rawContent,
        )
    return out


async def _record_edit_event(
    *,
    removed_indices: list[int],
    edited_sections: list[EditedSection],
    request_id: str,
) -> None:
    if not removed_indices and not edited_sections:
        return
    payload = {
        "removed_indices": sorted(set(removed_indices)),
        "edited_indices": sorted({e.index for e in edited_sections}),
        "request_id": request_id,
    }
    try:
        summary = json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        summary = str(payload)
    await client.add_memory(
        content=f"[edit_event] {summary}",
        metadata={
            "session_id": _session_id,
            "kind": "edit_event",
            "request_id": request_id,
            "deleted": False,
        },
    )


async def apply_edits_and_reingest(
    *,
    old_body: dict[str, Any],
    new_body: dict[str, Any],
    removed_indices: list[int],
    edited_sections: list[EditedSection],
    request_id: str,
) -> None:
    if not client.is_configured() or not _session_id:
        return
    try:
        async with _ingest_lock:
            old_map = _index_to_message_key(old_body)
            to_tombstone: set[str] = set()
            for idx in removed_indices:
                mk = old_map.get(idx)
                if mk:
                    to_tombstone.add(mk)
            for ed in edited_sections:
                mk = old_map.get(ed.index)
                if mk:
                    to_tombstone.add(mk)
            for mk in to_tombstone:
                await _tombstone_key(mk)
            await _record_edit_event(
                removed_indices=removed_indices,
                edited_sections=edited_sections,
                request_id=request_id,
            )
            await _ingest_canonical_body(new_body, request_id)
    except Exception:
        logger.exception("backboard: apply_edits ingest failed")


def schedule_after_edits(
    *,
    old_body: dict[str, Any],
    new_body: dict[str, Any],
    removed_indices: list[int],
    edited_sections: list[EditedSection],
    request_id: str,
) -> None:
    if not client.is_configured():
        return

    async def _run() -> None:
        await apply_edits_and_reingest(
            old_body=old_body,
            new_body=new_body,
            removed_indices=removed_indices,
            edited_sections=edited_sections,
            request_id=request_id,
        )

    asyncio.create_task(_run())
