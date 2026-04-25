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


def _apply_block_edit(block: Any, new_text: str) -> Any:
    """Apply a text edit to a single content block, preserving block type.

    For `text` and `tool_result` blocks the user's edit lands in the right
    field (`text` / `content`) so Anthropic still gets a structurally-correct
    block. For structured blocks (`tool_use`, `image`, unknown) we drop the
    edit and return the block unchanged — free-form text doesn't round-trip
    into a tool's `input` JSON or an image's `source`. The frontend marks
    these section types as read-only so the user is told upfront.
    """
    if not isinstance(block, dict):
        # String-content message: the whole content is just text.
        return new_text
    btype = block.get("type")
    if btype == "text":
        return {**block, "text": new_text}
    if btype == "tool_result":
        return {**block, "content": new_text}
    # tool_use, image, or unknown — edits don't round-trip into structured
    # fields. Preserve original; user must delete the section to skip.
    return block


def prune_orphan_tool_pairs(body: dict[str, Any]) -> dict[str, Any]:
    """Strip dangling tool_use / tool_result blocks so the forwarded body
    satisfies Anthropic's pairing rule: every tool_result must reference a
    tool_use in the immediately-prior assistant message, and every tool_use
    must be answered by a tool_result in the following user message.

    Triggers we guard against:
      * apply_edits removed a tool_use block (orphan tool_result downstream).
      * apply_edits dropped a whole assistant message because all its blocks
        were removed (every downstream tool_result for those uses orphaned).
      * apply_edits removed a tool_result (orphan tool_use upstream).
      * Canonical / incoming drift across sessions where length stayed the
        same but tool ids changed.

    Pruning a tool_use can in turn orphan the user's tool_result, and vice
    versa, and dropping an empty message can shift adjacency — so we iterate
    until stable (bounded; real cascades are 1-2 deep).
    """
    body = copy.deepcopy(body)

    pruned_uses_total = 0
    pruned_results_total = 0
    dropped_msgs_total = 0

    for _ in range(5):
        msgs = body.get("messages")
        if not isinstance(msgs, list) or not msgs:
            break

        use_ids_per_msg: list[set[str]] = []
        result_ids_per_msg: list[set[str]] = []
        for msg in msgs:
            uses: set[str] = set()
            results: set[str] = set()
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type")
                        if btype == "tool_use" and isinstance(block.get("id"), str):
                            uses.add(block["id"])
                        elif btype == "tool_result" and isinstance(
                            block.get("tool_use_id"), str
                        ):
                            results.add(block["tool_use_id"])
            use_ids_per_msg.append(uses)
            result_ids_per_msg.append(results)

        pruned_uses = 0
        pruned_results = 0
        new_msgs: list[Any] = []
        for i, msg in enumerate(msgs):
            if not isinstance(msg, dict):
                new_msgs.append(msg)
                continue
            role = msg.get("role")
            content = msg.get("content")
            if not isinstance(content, list):
                new_msgs.append(msg)
                continue

            if role == "assistant":
                next_results: set[str] = set()
                if i + 1 < len(msgs):
                    nxt = msgs[i + 1]
                    if isinstance(nxt, dict) and nxt.get("role") == "user":
                        next_results = result_ids_per_msg[i + 1]
                kept: list[Any] = []
                for block in content:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "tool_use"
                        and block.get("id") not in next_results
                    ):
                        pruned_uses += 1
                        continue
                    kept.append(block)
                msg = {**msg, "content": kept}
            elif role == "user":
                prior_uses: set[str] = set()
                if i > 0:
                    prior = msgs[i - 1]
                    if isinstance(prior, dict) and prior.get("role") == "assistant":
                        prior_uses = use_ids_per_msg[i - 1]
                kept = []
                for block in content:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "tool_result"
                        and block.get("tool_use_id") not in prior_uses
                    ):
                        pruned_results += 1
                        continue
                    kept.append(block)
                msg = {**msg, "content": kept}

            new_msgs.append(msg)

        # Anthropic rejects messages with empty content lists, mirroring the
        # explicit drop in apply_edits when every block was removed.
        cleaned: list[Any] = []
        dropped = 0
        for msg in new_msgs:
            if (
                isinstance(msg, dict)
                and isinstance(msg.get("content"), list)
                and len(msg["content"]) == 0
            ):
                dropped += 1
                continue
            cleaned.append(msg)

        body["messages"] = cleaned
        pruned_uses_total += pruned_uses
        pruned_results_total += pruned_results
        dropped_msgs_total += dropped

        if pruned_uses == 0 and pruned_results == 0 and dropped == 0:
            break

    if pruned_uses_total or pruned_results_total or dropped_msgs_total:
        logger.warning(
            "gating: pruned orphan tool blocks (tool_use=%d, tool_result=%d, "
            "dropped_empty_msgs=%d)",
            pruned_uses_total,
            pruned_results_total,
            dropped_msgs_total,
        )

    return body


def apply_edits(
    body: dict[str, Any],
    removed_indices: list[int],
    edited_sections: list[EditedSection],
) -> dict[str, Any]:
    """Apply UI edits to the upstream body in lockstep with classifier order:
    system (if any) → tool_defs → messages → blocks-within-each-message. Each
    Section the user saw in the chart corresponds to exactly one slot in this
    walk; we increment `next_index` after every slot, regardless of whether
    it's removed.

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
        if not isinstance(entry, dict):
            # Non-dict slot: classifier emitted one Section for it. Honor its
            # remove/edit decision but pass through unchanged otherwise.
            if next_index in removed:
                next_index += 1
                continue
            if next_index in edits:
                entry = edits[next_index]
            new_messages.append(entry)
            next_index += 1
            continue

        content = entry.get("content")
        if isinstance(content, list):
            new_blocks: list[Any] = []
            for block in content:
                if next_index in removed:
                    next_index += 1
                    continue
                if next_index in edits:
                    block = _apply_block_edit(block, edits[next_index])
                new_blocks.append(block)
                next_index += 1
            if not new_blocks:
                # All blocks removed — drop the whole message rather than
                # forwarding an empty content list (Anthropic rejects those).
                continue
            new_messages.append({**entry, "content": new_blocks})
        else:
            # String / scalar content — one section for the whole message.
            if next_index in removed:
                next_index += 1
                continue
            if next_index in edits:
                entry = {**entry, "content": edits[next_index]}
            new_messages.append(entry)
            next_index += 1

    body["messages"] = new_messages
    # Pair-prune AFTER structural edits — removing a tool_use block (or
    # dropping a whole assistant message) leaves the matching tool_result
    # downstream as an orphan, which Anthropic rejects with
    # `unexpected tool_use_id found in tool_result blocks`.
    return prune_orphan_tool_pairs(body)
