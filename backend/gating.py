from __future__ import annotations

import asyncio
import copy
import logging
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

import ws_manager
from models import EditedSection, TimeoutWarning

logger = logging.getLogger(__name__)

Mode = Literal["auto_send", "ask_permission"]
Decision = Literal["approve", "approve_modified", "cancel"]

mode: Mode = "auto_send"
pause_armed: bool = False
stream_in_flight: int = 0


@dataclass
class HeldRequest:
    request_id: str
    event: asyncio.Event = field(default_factory=asyncio.Event)
    decision: Optional[Decision] = None
    removed_indices: list[int] = field(default_factory=list)
    edited_sections: list[EditedSection] = field(default_factory=list)


in_flight: dict[str, HeldRequest] = {}


def set_mode(new_mode: Mode) -> None:
    global mode
    mode = new_mode
    logger.info("gating: mode=%s", mode)


def set_pause(paused: bool) -> None:
    global pause_armed
    pause_armed = paused
    logger.info("gating: pause_armed=%s", pause_armed)


def is_top_level(messages: list[dict[str, Any]]) -> bool:
    if not messages:
        return True
    last = messages[-1]
    if not isinstance(last, dict):
        return True
    content = last.get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return False
    return True


def should_hold(top_level: bool) -> bool:
    global pause_armed
    if mode == "ask_permission":
        return True
    if top_level and pause_armed:
        pause_armed = False
        return True
    return False


def register(request_id: str) -> HeldRequest:
    held = HeldRequest(request_id=request_id)
    in_flight[request_id] = held
    return held


async def await_decision(held: HeldRequest, timeout: float = 30.0) -> HeldRequest:
    try:
        await asyncio.wait_for(held.event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        await ws_manager.send(TimeoutWarning(requestId=held.request_id))
        await held.event.wait()
    return held


def resolve(
    request_id: str,
    decision: Decision,
    removed_indices: Optional[list[int]] = None,
    edited_sections: Optional[list[EditedSection]] = None,
) -> None:
    held = in_flight.get(request_id)
    if held is None:
        logger.warning("gating: resolve for unknown request_id=%s", request_id)
        return
    held.decision = decision
    held.removed_indices = removed_indices or []
    held.edited_sections = edited_sections or []
    held.event.set()


def release(request_id: str) -> None:
    in_flight.pop(request_id, None)


def _replace_text_in_content(content: Any, new_text: str) -> Any:
    if isinstance(content, str):
        return new_text
    if not isinstance(content, list):
        return new_text

    rebuilt = []
    text_replaced = False
    for block in content:
        if not isinstance(block, dict):
            rebuilt.append(block)
            continue
        btype = block.get("type")
        if btype == "text" and not text_replaced:
            rebuilt.append({**block, "text": new_text})
            text_replaced = True
        elif btype == "text":
            continue
        else:
            rebuilt.append(block)
    if not text_replaced:
        rebuilt.insert(0, {"type": "text", "text": new_text})
    return rebuilt


def apply_edits(
    body: dict[str, Any],
    removed_indices: list[int],
    edited_sections: list[EditedSection],
) -> dict[str, Any]:
    body = copy.deepcopy(body)
    has_system = bool(body.get("system"))
    removed = set(removed_indices)
    edits: dict[int, str] = {e.index: e.newContent for e in edited_sections}

    if has_system:
        if 0 in removed:
            body.pop("system", None)
        elif 0 in edits:
            body["system"] = edits[0]
        message_offset = 1
    else:
        message_offset = 0

    messages = body.get("messages", [])
    new_messages: list[Any] = []
    for i, entry in enumerate(messages):
        section_index = i + message_offset
        if section_index in removed:
            continue
        if section_index in edits and isinstance(entry, dict):
            entry = {
                **entry,
                "content": _replace_text_in_content(entry.get("content"), edits[section_index]),
            }
        new_messages.append(entry)

    body["messages"] = new_messages
    return body
