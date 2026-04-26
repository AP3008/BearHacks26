from __future__ import annotations

import copy
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
from backboard import ingest as bb_ingest
from models import NewRequest, Section

logger = logging.getLogger(__name__)

_RECENT_LIMIT = 32
_HISTORY_LIMIT = 20
recent_sections: dict[str, list[Section]] = {}
_recent_order: list[str] = []

# Snapshot inputs — `_held_requests` is the FIFO list of requests currently
# waiting on user approval. Claude Code is normally single-flight so this is
# usually 0-1 items, but two terminals pointing at the same proxy in
# ask_permission mode can put multiple holds in flight simultaneously, and
# without surfacing the full list the panel can only act on the first.
# `_latest_request` is the last new_request we sent so a freshly-attached
# panel still has *something* to render even when nothing is held.
# `_history` is a rolling buffer so the panel can show a request picker —
# without it, Claude Code's auxiliary calls (title generation, summary, etc.)
# silently overwrite the user's actual prompt within milliseconds.
_held_requests: list[NewRequest] = []
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
    """Back-compat: return the oldest held request (= the one the user should
    act on first). Newer panels read `held_requests()` for the full queue."""
    return _held_requests[0] if _held_requests else None


def held_requests() -> list[NewRequest]:
    """All requests currently held for approval, oldest first. Snapshot
    consumers iterate this so a reconnecting panel can rebuild its queue."""
    return list(_held_requests)


def latest_request() -> Optional[NewRequest]:
    return _latest_request


def recent_history() -> list[NewRequest]:
    return list(_history)


def _push_history(req: NewRequest) -> None:
    _history.append(req)
    while len(_history) > _HISTORY_LIMIT:
        _history.pop(0)


async def broadcast_canonical_snapshot() -> None:
    """Re-classify the current canonical and push it to the panel as a
    synthesized top-level NewRequest. Used after Reset Edits and after
    auto-mode commit_edits_now, so the chart re-renders immediately
    without waiting for Claude Code's next call. No-op if canonical is
    empty (no requests have flowed through yet)."""
    global _latest_request
    body = await conversation_state.get_canonical()
    if not body:
        return
    request_id = uuid.uuid4().hex
    sections, total_tokens, total_cost, model = classifier.classify(body)
    _remember(request_id, sections)
    new_request = NewRequest(
        requestId=request_id,
        sections=sections,
        totalTokens=total_tokens,
        totalCost=total_cost,
        model=model,
        held=False,
        kind="top_level",
        lastUserPreview=_last_user_preview(body.get("messages", [])),
        createdAt=time.time(),
    )
    _latest_request = new_request
    _push_history(new_request)
    await ws_manager.send(new_request)


def _strip_excess_cache_control(body: dict[str, Any], max_blocks: int = 4) -> tuple[dict[str, Any], int]:
    """Anthropic enforces a hard cap on the number of blocks containing
    `cache_control` across the entire request. Some upstream clients (e.g. IDE
    agents) can exceed this, which causes a 400.

    We keep the first `max_blocks` occurrences (in a stable traversal order)
    and remove `cache_control` from any additional blocks.
    """

    def _walk(value: Any, state: dict[str, int]) -> None:
        # Anthropic's `cache_control` shows up on "content blocks", but different
        # clients nest those blocks in different places (system, messages,
        # tool_result content, tool inputs, etc.). Walk the full JSON structure
        # so we reliably stay under the upstream cap.
        if isinstance(value, dict):
            if "cache_control" in value:
                state["seen"] += 1
                if state["seen"] > max_blocks:
                    value.pop("cache_control", None)
                    state["stripped"] += 1
            for v in value.values():
                _walk(v, state)
            return
        if isinstance(value, list):
            for item in value:
                _walk(item, state)
            return

    state = {"seen": 0, "stripped": 0}

    _walk(body, state)

    return body, state["stripped"]


async def handle(request: Request) -> Response:
    global _latest_request

    raw = await request.body()
    headers = dict(request.headers)
    bb_ingest.set_user_key(headers.get("x-autonomy-user", "local"))

    try:
        body: dict[str, Any] = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.warning(
            "interceptor: non-json body (%s, len=%d) — gate bypassed, forwarding raw",
            type(exc).__name__,
            len(raw),
        )
        return await _forward_raw(raw, headers)

    if not isinstance(body, dict) or "messages" not in body:
        keys = list(body.keys()) if isinstance(body, dict) else []
        logger.warning(
            "interceptor: body missing 'messages' (top-level keys=%s) — gate bypassed, forwarding raw",
            keys,
        )
        return await _forward_raw(raw, headers)

    # Safety: enforce Anthropic's cap on cache_control blocks for ALL requests.
    # This prevents upstream 400s when ANY caller adds more than allowed.
    body, stripped = _strip_excess_cache_control(body, max_blocks=4)
    if stripped:
        logger.warning(
            "interceptor: stripped %d excess cache_control blocks to satisfy upstream limit",
            stripped,
        )

    # Aux calls (title gen, topic detection, summarization) ship no `tools`
    # and a tiny system prompt. They aren't part of the user's main
    # conversation, so they bypass the canonical entirely — appending their
    # 1-2 messages to canonical would corrupt last_seen tracking. Forward
    # untouched, exactly like before.
    if not conversation_state.is_main_conversation(body):
        return await forwarder.forward_messages(body, headers)

    request_id = uuid.uuid4().hex
    pre_sync = copy.deepcopy(body)

    # Merge into canonical BEFORE classifying. The bar chart, the held copy,
    # the snapshot replay, and the upstream forward all see the same canonical.
    body = await conversation_state.sync(body)

    bb_ingest.schedule_raw_incoming(pre_sync, request_id)
    bb_ingest.schedule_canonical_synced(copy.deepcopy(body), request_id)
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
            "Autonomy panel to gate the next request.",
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
        _held_requests.append(new_request)

    await ws_manager.send(new_request)
    # Gemma flagging runs on demand when requested by the UI (see
    # RequestFlagging → analyzer.flag in main.py), not for every request.

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
                    held.removed_indices,
                    held.edited_sections,
                    request_id=request_id,
                )
        finally:
            gating.release(request_id)
            # Drop this request from the held queue regardless of position —
            # decision (approve/cancel/modified) has been made or we errored.
            for i, req in enumerate(_held_requests):
                if req.requestId == request_id:
                    _held_requests.pop(i)
                    break

    return await forwarder.forward_messages(body, headers)


async def _forward_raw(raw: bytes, headers: dict[str, str]) -> Response:
    try:
        body = json.loads(raw)
        if isinstance(body, dict):
            return await forwarder.forward_messages(body, headers)
    except Exception:
        pass
    return await forwarder.forward_messages({}, headers)
