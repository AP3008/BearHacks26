from __future__ import annotations

import asyncio
import copy
import logging
from typing import Any, Optional

import gating
from models import EditedSection

logger = logging.getLogger(__name__)

# Canonical edited conversation maintained server-side. Treat the proxy as the
# source of truth for "what gets sent upstream" — Claude Code keeps its own
# unedited history client-side and replays it on every request, so without
# this, user deletes/edits last only for one request before being undone by
# Claude Code's next replay. Each new Claude Code request only contributes
# its new turn (tool_result(s) or a new user message); we slice that delta
# off the tail, append it to canonical, and forward canonical upstream.
_canonical: Optional[dict[str, Any]] = None
# Count of messages in the LAST INCOMING (Claude Code's view), pre-edits.
# Stays at Claude Code's count even if the user has shrunk canonical, so
# `incoming.messages[_last_seen_message_count:]` always slices off only the
# genuinely-new tail.
_last_seen_message_count: int = 0
_lock: asyncio.Lock = asyncio.Lock()


def is_main_conversation(body: dict[str, Any]) -> bool:
    """Mirror of frontend's isMainConversationRequest. Claude Code's
    auxiliary calls (title generation, topic detection, summarization) ship
    a tiny system prompt and no `tools`; the main conversation always
    defines the full tool set. We bypass the canonical for aux calls so
    they don't pollute message-count tracking."""
    if not isinstance(body, dict):
        return False
    tools = body.get("tools")
    return isinstance(tools, list) and len(tools) > 0


def _looks_like_new_session(incoming: dict[str, Any]) -> bool:
    """Detect Claude Code restart / fresh session: incoming is shorter than
    `_last_seen_message_count`. Length-only — we cannot compare canonical's
    first-N roles against incoming because user edits may have legitimately
    removed messages from canonical, making the roles diverge by design.
    Length is the one signal that's stable across user edits (last_seen
    tracks Claude Code's view, not ours)."""
    msgs = incoming.get("messages") or []
    if not isinstance(msgs, list):
        return True
    return len(msgs) < _last_seen_message_count


async def sync(incoming: dict[str, Any]) -> dict[str, Any]:
    """Merge incoming Claude Code body into canonical and return the body
    to use going forward. Caller is responsible for confirming this is a
    main-conversation call via `is_main_conversation` first."""
    global _canonical, _last_seen_message_count
    async with _lock:
        msgs = incoming.get("messages") or []
        if not isinstance(msgs, list):
            msgs = []

        if _canonical is None or _looks_like_new_session(incoming):
            if _canonical is not None:
                logger.warning(
                    "conversation_state: detected new session "
                    "(incoming msgs=%d, last_seen=%d) — re-initializing canonical",
                    len(msgs),
                    _last_seen_message_count,
                )
            _canonical = copy.deepcopy(incoming)
            _last_seen_message_count = len(msgs)
            return copy.deepcopy(_canonical)

        delta = msgs[_last_seen_message_count:]
        if delta:
            canonical_msgs = _canonical.get("messages")
            if not isinstance(canonical_msgs, list):
                canonical_msgs = []
                _canonical["messages"] = canonical_msgs
            canonical_msgs.extend(copy.deepcopy(delta))
            logger.info(
                "conversation_state: appended %d new messages "
                "(canonical=%d, last_seen=%d→%d)",
                len(delta),
                len(canonical_msgs),
                _last_seen_message_count,
                len(msgs),
            )
        _last_seen_message_count = len(msgs)
        return copy.deepcopy(_canonical)


async def commit_edits(
    removed_indices: list[int],
    edited_sections: list[EditedSection],
) -> dict[str, Any]:
    """Apply user edits to canonical (system → tools → messages slot walk).
    Returns the new canonical for forwarding."""
    global _canonical
    async with _lock:
        if _canonical is None:
            logger.warning("conversation_state: commit_edits with empty canonical")
            return {}
        _canonical = gating.apply_edits(_canonical, removed_indices, edited_sections)
        logger.info(
            "conversation_state: committed removed=%d edited=%d (canonical msgs=%d)",
            len(removed_indices),
            len(edited_sections),
            len(_canonical.get("messages") or []),
        )
        return copy.deepcopy(_canonical)


async def reset() -> None:
    global _canonical, _last_seen_message_count
    async with _lock:
        _canonical = None
        _last_seen_message_count = 0
        logger.info("conversation_state: reset")
