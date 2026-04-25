from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import Request, Response

import classifier
import forwarder
import gating
import ws_manager
from gemma import analyzer
from models import NewRequest, Section

logger = logging.getLogger(__name__)

_RECENT_LIMIT = 32
recent_sections: dict[str, list[Section]] = {}
_recent_order: list[str] = []


def _remember(request_id: str, sections: list[Section]) -> None:
    recent_sections[request_id] = sections
    _recent_order.append(request_id)
    while len(_recent_order) > _RECENT_LIMIT:
        old = _recent_order.pop(0)
        recent_sections.pop(old, None)


async def handle(request: Request) -> Response:
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

    request_id = uuid.uuid4().hex
    sections, total_tokens, total_cost, model = classifier.classify(body)
    _remember(request_id, sections)

    new_request = NewRequest(
        requestId=request_id,
        sections=sections,
        totalTokens=total_tokens,
        totalCost=total_cost,
        model=model,
    )
    await ws_manager.send(new_request)

    asyncio.create_task(analyzer.flag(request_id, sections))

    top_level = gating.is_top_level(body.get("messages", []))
    must_hold = ws_manager.is_connected() and gating.should_hold(top_level)

    if must_hold:
        held = gating.register(request_id)
        try:
            await gating.await_decision(held)
            if held.decision == "cancel":
                logger.info("interceptor: cancelled request_id=%s", request_id)
                return Response(status_code=499)
            if held.decision == "approve_modified":
                body = gating.apply_edits(body, held.removed_indices, held.edited_sections)
        finally:
            gating.release(request_id)

    return await forwarder.forward_messages(body, headers)


async def _forward_raw(raw: bytes, headers: dict[str, str]) -> Response:
    try:
        body = json.loads(raw)
        if isinstance(body, dict):
            return await forwarder.forward_messages(body, headers)
    except Exception:
        pass
    return await forwarder.forward_messages({}, headers)
