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
# Parallel "full" canonical that mirrors `_canonical` but is NEVER touched by
# user edits — it tracks the conversation as Claude Code sent it. Used by
# Reset Edits to restore the un-edited view; without this, "reset" could
# only nuke state, leaving the user with no way to recover deleted sections
# from a prompt three turns ago.
_canonical_full: Optional[dict[str, Any]] = None
# Count of messages in the LAST INCOMING (Claude Code's view), pre-edits.
# Stays at Claude Code's count even if the user has shrunk canonical, so
# `incoming.messages[_last_seen_message_count:]` always slices off only the
# genuinely-new tail.
_last_seen_message_count: int = 0
# After ResetCanonical we already rotate Backboard session in reset(); skip the
# duplicate rotate on the next sync when _canonical is first repopulated.
_skip_next_backboard_rotate: bool = False
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
    global _canonical, _canonical_full, _last_seen_message_count, _skip_next_backboard_rotate
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
            try:
                from backboard import ingest as bb_ingest

                if _canonical is not None:
                    bb_ingest.rotate_session()
                elif _skip_next_backboard_rotate:
                    _skip_next_backboard_rotate = False
                else:
                    bb_ingest.rotate_session()
            except Exception:
                logger.exception("conversation_state: backboard rotate_session failed")
            _canonical = copy.deepcopy(incoming)
            _canonical_full = copy.deepcopy(incoming)
            _last_seen_message_count = len(msgs)
            return copy.deepcopy(_canonical)

        delta = msgs[_last_seen_message_count:]
        if delta:
            canonical_msgs = _canonical.get("messages")
            if not isinstance(canonical_msgs, list):
                canonical_msgs = []
                _canonical["messages"] = canonical_msgs
            canonical_msgs.extend(copy.deepcopy(delta))
            # Mirror the same delta into the unedited full canonical. We
            # deepcopy a second time because the canonical-edited copy is
            # later mutated in place by `apply_edits`, and we don't want
            # those mutations to leak into the full store via shared refs.
            if _canonical_full is not None:
                full_msgs = _canonical_full.get("messages")
                if not isinstance(full_msgs, list):
                    full_msgs = []
                    _canonical_full["messages"] = full_msgs
                full_msgs.extend(copy.deepcopy(delta))
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
    *,
    request_id: str = "",
) -> dict[str, Any]:
    """Apply user edits to canonical (system → tools → messages slot walk).
    Returns the new canonical for forwarding."""
    global _canonical
    async with _lock:
        if _canonical is None:
            logger.warning("conversation_state: commit_edits with empty canonical")
            return {}
        old = copy.deepcopy(_canonical)
        _canonical = gating.apply_edits(_canonical, removed_indices, edited_sections)
        logger.info(
            "conversation_state: committed removed=%d edited=%d (canonical msgs=%d)",
            len(removed_indices),
            len(edited_sections),
            len(_canonical.get("messages") or []),
        )
        result = copy.deepcopy(_canonical)
    if request_id:
        try:
            from backboard import ingest as bb_ingest

            bb_ingest.schedule_after_edits(
                old_body=old,
                new_body=result,
                removed_indices=removed_indices,
                edited_sections=edited_sections,
                request_id=request_id,
            )
        except Exception:
            logger.exception("conversation_state: backboard schedule_after_edits failed")
    return result


async def reset_edits() -> Optional[dict[str, Any]]:
    """Restore the edited canonical from the un-edited full canonical so all
    user deletes/edits are reverted in one go. Leaves `_canonical_full` and
    `_last_seen_message_count` alone — Claude Code's view is unchanged, only
    the proxy's edited copy resets. If no full canonical exists yet (no
    requests have flowed through), performs a hard reset so the next request
    re-initializes cleanly."""
    global _canonical, _canonical_full, _last_seen_message_count, _skip_next_backboard_rotate
    hard_reset = False
    result: Optional[dict[str, Any]] = None
    async with _lock:
        if _canonical_full is None:
            _canonical = None
            _last_seen_message_count = 0
            _skip_next_backboard_rotate = True
            hard_reset = True
            logger.info("conversation_state: hard reset (no full canonical)")
        else:
            _canonical = copy.deepcopy(_canonical_full)
            logger.info(
                "conversation_state: reset_edits restored canonical from full "
                "(messages=%d)",
                len(_canonical.get("messages") or []),
            )
            result = copy.deepcopy(_canonical)
    if hard_reset:
        try:
            from backboard import ingest as bb_ingest

            bb_ingest.rotate_session()
        except Exception:
            logger.exception("conversation_state: backboard rotate_session on reset failed")
    return result


# Back-compat alias — older callers import `reset`. New code should call
# `reset_edits` so the intent (revert edits, keep tracking) is explicit.
reset = reset_edits


async def get_canonical() -> Optional[dict[str, Any]]:
    """Return a deep copy of the current edited canonical, or None if no
    request has been synced yet. Used by callers that need to re-classify
    the latest body without going through Claude Code (e.g. broadcasting a
    fresh snapshot to the panel after Reset Edits)."""
    async with _lock:
        if _canonical is None:
            return None
        return copy.deepcopy(_canonical)


async def update_canonical(new_body: dict[str, Any]) -> None:
    """Update the canonical conversation state with a new body. Used when
    adding the assistant response from the streaming response back."""
    global _canonical, _canonical_full
    async with _lock:
        _canonical = copy.deepcopy(new_body)
        # Also update the full canonical to keep them in sync
        if _canonical_full is not None:
            _canonical_full = copy.deepcopy(new_body)
        logger.info(
            "conversation_state: updated canonical (messages=%d)",
            len(_canonical.get("messages") or []),
        )


