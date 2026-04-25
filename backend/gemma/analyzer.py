from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

import gating
import ws_manager
from backboard import rag as backboard_rag
from models import GemmaFlags, Section

from . import prompts
from .parser import parse_flags

logger = logging.getLogger(__name__)

_available: bool = False
_host: str = "http://localhost:11434"
_model: str = "gemma4:e4b"
_client: Optional[Any] = None
_chat_timeout_s: float = 45.0


def configure(host: str, model: str) -> None:
    global _host, _model, _chat_timeout_s
    _host = host
    _model = model
    _chat_timeout_s = float(os.getenv("GEMMA_CHAT_TIMEOUT_S", "45"))


def is_available() -> bool:
    return _available


async def probe() -> None:
    global _available, _client
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{_host}/api/tags")
        if resp.status_code != 200:
            raise RuntimeError(f"ollama /api/tags returned {resp.status_code}")
        models = [m.get("name", "") for m in resp.json().get("models", [])]
        if _model not in models:
            logger.warning(
                "gemma: model %s not present in ollama (have %s); flagging disabled",
                _model,
                models,
            )
            _available = False
            return
        # NOTE: we intentionally do not use the `ollama` python client for chat
        # calls. Some Ollama response fields (notably `message.thinking`) are
        # not preserved by the client's typed models in certain versions,
        # which can make `message.content` appear empty even when the model
        # returned useful output. Using httpx keeps the raw JSON intact.
        _client = True
        _available = True
        logger.info("gemma: available (model=%s, host=%s)", _model, _host)
    except Exception as exc:
        logger.warning("gemma: ollama not reachable at %s (%s); flagging disabled", _host, exc)
        _available = False


async def _wait_for_idle(max_wait_s: float = 8.0) -> None:
    """Defer Gemma until the upstream stream completes (NFR-2.3) but never
    block longer than max_wait_s — if stream_in_flight ever leaks, Gemma
    would otherwise be silently disabled forever."""
    deadline = asyncio.get_event_loop().time() + max_wait_s
    while gating.stream_in_flight > 0 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)


async def _chat_flagging(
    system: str, user: str, *, log_request_id: str = "", log_section_index: int | None = None
) -> Optional[str]:
    """Ollama chat with JSON Schema output. Never treats `message.thinking` as the model output."""
    if _client is None:
        return None
    # Gemma 4 prompt formatting: explicitly separate system/user/model turns
    # using Gemma's reserved control tokens.
    formatted = prompts.format_gemma4_dialogue(system=system, user=user)
    try:
        async with httpx.AsyncClient(timeout=_chat_timeout_s) as client:
            resp = await asyncio.wait_for(
                client.post(
                    f"{_host}/api/chat",
                    json={
                        "model": _model,
                        # Parser is already tolerant of minor JSON wrapping and
                        # the system prompt defines the shape; avoid strict
                        # schema enforcement unless we need it.
                        "format": "json",
                        "options": {
                            "temperature": 0,
                            # Allow enough room for large highlight arrays.
                            "num_predict": 2048,
                        },
                        "keep_alive": "10m",
                        "messages": [
                            # Use a single user message containing the full
                            # Gemma 4 formatted dialogue. This prevents any
                            # ambiguity in how system vs user text are
                            # separated by the serving layer.
                            {"role": "user", "content": formatted},
                        ],
                        "stream": False,
                    },
                ),
                timeout=_chat_timeout_s,
            )
        if resp.status_code != 200:
            logger.warning(
                "gemma: chat HTTP %s (model=%s host=%s body=%s)",
                resp.status_code,
                _model,
                _host,
                (resp.text or "")[:400],
            )
            return None
        resp = resp.json()
    except asyncio.TimeoutError:
        logger.warning("gemma: chat call timed out (model=%s host=%s)", _model, _host)
        raise
    except Exception as exc:
        logger.warning(
            "gemma: chat call failed (model=%s host=%s exc=%s: %r)",
            _model,
            _host,
            type(exc).__name__,
            exc,
        )
        return None
    msg = resp.get("message") if isinstance(resp, dict) else getattr(resp, "message", None)
    if isinstance(msg, dict):
        content = msg.get("content")
        thinking = msg.get("thinking")
    else:
        content = getattr(msg, "content", None)
        thinking = getattr(msg, "thinking", None)

    # Log every response.
    think_preview = ""
    if isinstance(thinking, str) and thinking.strip():
        think_preview = thinking.strip().replace("\n", "\\n")[:4000]

    if content is not None and not isinstance(content, str):
        logger.warning(
            "gemma: non-string chat content (model=%s host=%s type=%s value=%r)",
            _model,
            _host,
            type(content).__name__,
            content,
        )
        return None

    if isinstance(content, str) and content.strip():
        out = content.strip().replace("\n", "\\n")
        ctx = f" request_id={log_request_id}" if log_request_id else ""
        if log_section_index is not None:
            ctx += f" index={log_section_index}"
        logger.info(
            "gemma: flagging response content (model=%s)%s content=%s thinking_preview=%s",
            _model,
            ctx,
            out[:12000],
            think_preview[:1200] if think_preview else "",
        )
        return content

    if isinstance(thinking, str) and thinking.strip():
        # Some Ollama builds place the JSON into `message.thinking` even when
        # `format="json"` is set. If `content` is empty, try extracting flags
        # from thinking so we don't silently drop valid results.
        recovered = parse_flags(thinking, default_section_index=log_section_index)
        if recovered:
            logger.warning(
                "gemma: recovered flags from thinking (model=%s host=%s flags=%d thinking_preview=%s)",
                _model,
                _host,
                len(recovered),
                think_preview[:1200],
            )
            return thinking
        logger.warning(
            "gemma: empty content but thinking present (no recoverable JSON; model=%s host=%s) thinking=%s",
            _model,
            _host,
            think_preview[:2000],
        )
    else:
        try:
            keys = list(resp.keys()) if isinstance(resp, dict) else []
        except Exception:
            keys = []
        try:
            msg_keys = list(msg.keys()) if isinstance(msg, dict) else []
        except Exception:
            msg_keys = []
        logger.warning(
            "gemma: empty flagging content (model=%s host=%s resp_keys=%s msg_keys=%s msg=%r)",
            _model,
            _host,
            keys,
            msg_keys,
            msg,
        )
    return None


async def flag(request_id: str, sections: list[Section]) -> None:
    if not _available:
        return
    try:
        await _wait_for_idle()
        prior = await backboard_rag.fetch_prior_memories(sections[0].rawContent) if sections else []
        user = prompts.flagging_user(sections, prior_memories=prior or None)
        raw = await _chat_flagging(prompts.FLAGGING_SYSTEM, user, log_request_id=request_id)
        if raw is None:
            return
        # We only ever send one section in the user payload today (see
        # prompts.flagging_user). Provide a default index so we don't drop
        # otherwise-valid structured output that omits sectionIndex.
        default_idx = sections[0].index if sections else None
        flags = (
            parse_flags(raw, default_section_index=default_idx)
            if default_idx is not None
            else parse_flags(raw)
        )
        await ws_manager.send(GemmaFlags(requestId=request_id, flags=flags))
    except Exception:
        logger.exception("gemma: flag task crashed")


async def flag_for_section(request_id: str, section: Section) -> None:
    # Always respond (even empty) so the UI can clear its pending spinner.
    if not _available:
        try:
            await ws_manager.send(GemmaFlags(requestId=request_id, flags=[]))
        except Exception:
            logger.exception("gemma: failed to send empty flags (unavailable)")
        return
    try:
        await _wait_for_idle()
        prior = await backboard_rag.fetch_prior_memories(section.rawContent)
        user = prompts.flagging_user([section], prior_memories=prior or None)
        raw = await _chat_flagging(
            prompts.FLAGGING_SYSTEM,
            user,
            log_request_id=request_id,
            log_section_index=section.index,
        )
        if raw is None:
            await ws_manager.send(GemmaFlags(requestId=request_id, flags=[]))
            return
        flags = parse_flags(raw, default_section_index=section.index)
        if not flags:
            await ws_manager.send(GemmaFlags(requestId=request_id, flags=[]))
            return
        # UI expects one flag per section index. Collapse into a single entry.
        severity_rank = {"low": 0, "medium": 1, "high": 2}
        top = max(flags, key=lambda f: severity_rank.get(f.severity, 0))
        highlights = []
        for f in flags:
            highlights.extend(f.highlights or [])
        collapsed = top.model_copy(update={"highlights": highlights})
        await ws_manager.send(GemmaFlags(requestId=request_id, flags=[collapsed]))
    except Exception:
        logger.exception("gemma: flag_for_section task crashed")
        try:
            await ws_manager.send(GemmaFlags(requestId=request_id, flags=[]))
        except Exception:
            logger.exception("gemma: failed to send empty flags after crash")
