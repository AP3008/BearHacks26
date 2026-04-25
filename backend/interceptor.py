from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Optional

from fastapi import Request, Response

import classifier
import conversation_state
import forwarder
import gating
import ws_manager
from gemma import analyzer
from models import NewRequest, Section

logger = logging.getLogger(__name__)

_RECENT_LIMIT = 32
_HISTORY_LIMIT = 20
recent_sections: dict[str, list[Section]] = {}
_recent_order: list[str] = []

# Snapshot inputs — `_held_request` is the request currently waiting on user
# approval (at most one in normal use, since Claude Code is single-flight).
# `_latest_request` is the last new_request we sent so a freshly-attached
# panel still has *something* to render even when nothing is held.
# `_history` is a rolling buffer so the panel can show a request picker —
# without it, Claude Code's auxiliary calls (title generation, summary, etc.)
# silently overwrite the user's actual prompt within milliseconds.
_held_request: Optional[NewRequest] = None
_latest_request: Optional[NewRequest] = None
_history: list[NewRequest] = []


def _last_user_preview(messages: list[Any]) -> str:
    """Return a short preview of the last user-authored text in the request,
    so the picker can show 'tell me about dinosaurs' instead of just a token
    count."""
    for entry in reversed(messages):
        if not isinstance(entry, dict) or entry.get("role") != "user":
            continue
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
            return flat[:120]
    return ""


def _remember(request_id: str, sections: list[Section]) -> None:
    recent_sections[request_id] = sections
    _recent_order.append(request_id)
    while len(_recent_order) > _RECENT_LIMIT:
        old = _recent_order.pop(0)
        recent_sections.pop(old, None)


def held_request() -> Optional[NewRequest]:
    return _held_request


def latest_request() -> Optional[NewRequest]:
    return _latest_request


def recent_history() -> list[NewRequest]:
    return list(_history)


def _push_history(req: NewRequest) -> None:
    _history.append(req)
    while len(_history) > _HISTORY_LIMIT:
        _history.pop(0)


async def handle(request: Request) -> Response:
    global _held_request, _latest_request

    raw = await request.body()
    headers = dict(request.headers)

    try:
        body: dict[str, Any] = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.info("interceptor: non-json body, forwarding raw")
        return await _forward_raw(raw, headers)

    if not isinstance(body, dict) or "messages" not in body:
        logger.info("interceptor: missing messages array, forwarding raw")
        return await _forward_raw(raw, headers)

    # Aux calls (title gen, topic detection, summarization) ship no `tools`
    # and a tiny system prompt. They aren't part of the user's main
    # conversation, so they bypass the canonical entirely — appending their
    # 1-2 messages to canonical would corrupt last_seen tracking. Forward
    # untouched, exactly like before.
    if not conversation_state.is_main_conversation(body):
        return await forwarder.forward_messages(body, headers)

    # Merge into canonical BEFORE classifying. The bar chart, the held copy,
    # the snapshot replay, and the upstream forward all see the same canonical.
    body = await conversation_state.sync(body)

    request_id = uuid.uuid4().hex
    sections, total_tokens, total_cost, model = classifier.classify(body)
    _remember(request_id, sections)

    top_level = gating.is_top_level(body.get("messages", []))
    ws_connected = ws_manager.is_connected()
    hold_intent = gating.will_hold(top_level)
    must_hold = hold_intent and ws_connected

    if hold_intent and not ws_connected:
        # Don't silently bypass the user's gating intent. We still pass the
        # request through (failing it would break Claude Code mid-task), but
        # we log loudly and we do NOT consume pause_armed — so the next
        # request after the panel reconnects will still be held.
        logger.warning(
            "interceptor: gating wanted to hold request_id=%s but no UI "
            "client is connected; passing through unheld. Open the "
            "ContextLens panel to gate the next request.",
            request_id,
        )

    if must_hold:
        gating.commit_pause_consumed(top_level)

    new_request = NewRequest(
        requestId=request_id,
        sections=sections,
        totalTokens=total_tokens,
        totalCost=total_cost,
        model=model,
        held=must_hold,
        kind="top_level" if top_level else "tool_chain",
        lastUserPreview=_last_user_preview(body.get("messages", [])),
        createdAt=time.time(),
    )

    # Update snapshot state BEFORE sending, so a reconnect that races the
    # send still sees this request via the snapshot replay.
    _latest_request = new_request
    _push_history(new_request)
    if must_hold:
        _held_request = new_request

    await ws_manager.send(new_request)
    asyncio.create_task(analyzer.flag(request_id, sections))

    if must_hold:
        held = gating.register(request_id)
        try:
            await gating.await_decision(held)
            if held.decision == "cancel":
                logger.info("interceptor: cancelled request_id=%s", request_id)
                return Response(status_code=499)
            if held.decision == "approve_modified":
                logger.info(
                    "interceptor: applying edits request_id=%s removed=%d edited=%d",
                    request_id,
                    len(held.removed_indices),
                    len(held.edited_sections),
                )
                body = await conversation_state.commit_edits(
                    held.removed_indices, held.edited_sections
                )
        finally:
            gating.release(request_id)
            if _held_request is not None and _held_request.requestId == request_id:
                _held_request = None

    return await forwarder.forward_messages(body, headers)


async def _forward_raw(raw: bytes, headers: dict[str, str]) -> Response:
    try:
        body = json.loads(raw)
        if isinstance(body, dict):
            return await forwarder.forward_messages(body, headers)
    except Exception:
        pass
    return await forwarder.forward_messages({}, headers)
