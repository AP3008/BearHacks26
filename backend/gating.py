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


def will_hold(top_level: bool) -> bool:
    """Decide whether the current request *should* be held, without mutating
    pause-armed state. The caller commits the consumption only after it has
    confirmed there is a UI client available to act on the hold."""
    if mode == "ask_permission":
        return True
    if top_level and pause_armed:
        return True
    return False


def commit_pause_consumed(top_level: bool) -> None:
    """Burn the one-shot pause flag, but only when we know we will actually
    hold the request. Previously `should_hold` consumed pause_armed even if
    `must_hold` later ended up False (no UI connected), silently losing the
    user's pause intent."""
    global pause_armed
    if mode != "ask_permission" and top_level and pause_armed:
        pause_armed = False


def state() -> dict[str, Any]:
    return {"mode": mode, "paused": pause_armed}


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

    has_tool_result = any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )

    rebuilt = []
    replaced = False
    for block in content:
        if not isinstance(block, dict):
            rebuilt.append(block)
            continue
        btype = block.get("type")
        if has_tool_result and btype == "tool_result":
            # The user's edit is the new tool_result content. Preserve the
            # tool_use_id so Anthropic can match it; only the first tool_result
            # absorbs the edit, the rest are dropped (a single section maps to
            # a single user-visible blob of tool output).
            if not replaced:
                rebuilt.append({**block, "content": new_text})
                replaced = True
            continue
        if has_tool_result and btype == "text":
            # Drop sibling text blocks — the edit fully replaces the section.
            continue
        if not has_tool_result and btype == "text":
            if not replaced:
                rebuilt.append({**block, "text": new_text})
                replaced = True
            else:
                continue
        else:
            # tool_use, image, or any other block type — preserve unchanged.
            rebuilt.append(block)
    if not replaced:
        rebuilt.insert(0, {"type": "text", "text": new_text})
    return rebuilt


def apply_edits(
    body: dict[str, Any],
    removed_indices: list[int],
    edited_sections: list[EditedSection],
) -> dict[str, Any]:
    """Apply UI edits to the upstream body in lockstep with classifier order:
    system (if any) → tool_defs → messages. Each Section the user could see
    in the chart corresponds to exactly one slot in this walk; we increment
    `next_index` after every slot, regardless of whether it's removed.

    Tool-def edits are intentionally ignored — Anthropic's `tools` entries are
    structured objects with name/description/input_schema, and free-form text
    edits don't round-trip back into that schema. Deletes work because they
    just drop the entry.
    """
    body = copy.deepcopy(body)
    removed = set(removed_indices)
    edits: dict[int, str] = {e.index: e.newContent for e in edited_sections}
    next_index = 0

    has_system = bool(body.get("system"))
    if has_system:
        if next_index in removed:
            body.pop("system", None)
        elif next_index in edits:
            body["system"] = edits[next_index]
        next_index += 1

    tools = body.get("tools")
    if isinstance(tools, list) and tools:
        new_tools: list[Any] = []
        for tool in tools:
            if next_index in removed:
                next_index += 1
                continue
            new_tools.append(tool)
            next_index += 1
        if new_tools:
            body["tools"] = new_tools
        else:
            body.pop("tools", None)

    messages = body.get("messages", [])
    new_messages: list[Any] = []
    for entry in messages:
        if next_index in removed:
            next_index += 1
            continue
        if next_index in edits and isinstance(entry, dict):
            entry = {
                **entry,
                "content": _replace_text_in_content(entry.get("content"), edits[next_index]),
            }
        new_messages.append(entry)
        next_index += 1

    body["messages"] = new_messages
    return body
