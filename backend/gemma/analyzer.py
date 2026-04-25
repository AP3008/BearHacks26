from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

import gating
import ws_manager
from models import GemmaFlags, GemmaSuggestion, Section

from . import prompts
from .parser import parse_flags, parse_suggestion

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
        from ollama import AsyncClient as OllamaClient  # type: ignore

        _client = OllamaClient(host=_host)
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


async def _chat(system: str, user: str) -> Optional[str]:
    if _client is None:
        return None
    try:
        # Ollama can occasionally stall (cold model load, GPU contention, or
        # the model drifting into verbose JSON). Keep this path responsive by
        # bounding both runtime and output length.
        resp = await asyncio.wait_for(
            _client.chat(
                model=_model,
                format="json",
                options={
                    "temperature": 0,
                    "num_predict": 256,
                },
                keep_alive="10m",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            ),
            timeout=_chat_timeout_s,
        )
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
        return msg.get("content")
    return getattr(msg, "content", None)


async def flag(request_id: str, sections: list[Section]) -> None:
    if not _available:
        return
    try:
        await _wait_for_idle()
        user = prompts.flagging_user(sections)
        raw = await _chat(prompts.FLAGGING_SYSTEM, user)
        if raw is None:
            return
        flags = parse_flags(raw)
        await ws_manager.send(GemmaFlags(requestId=request_id, flags=flags))
    except Exception:
        logger.exception("gemma: flag task crashed")


async def suggest(request_id: str, section_index: int, sections: list[Section]) -> None:
    if not _available:
        return
    try:
        section = next((s for s in sections if s.index == section_index), None)
        if section is None:
            return
        goal = ""
        for s in sections:
            if s.sectionType == "user":
                goal = s.rawContent
                break
        await suggest_for_section(request_id=request_id, section=section, goal=goal)
    except Exception:
        logger.exception("gemma: suggest task crashed")


async def suggest_for_section(request_id: str, section: Section, goal: str) -> None:
    """Run Gemma only on the user-selected section.

    Callers should pass the specific `Section` the user chose (and an optional
    goal string) so we never accidentally ship the full request context into
    the model."""
    if not _available:
        return
    highlights = []
    try:
        await _wait_for_idle()
        user = prompts.suggestion_user(section, goal)
        raw = await _chat(prompts.SUGGESTION_SYSTEM, user)
        if raw is None:
            return
        highlights = parse_suggestion(raw)
        logger.info(
            "gemma: suggestion ok request_id=%s index=%s highlights=%d raw=%s",
            request_id,
            section.index,
            len(highlights),
            raw,
        )
    except asyncio.TimeoutError:
        logger.warning("gemma: suggestion timed out request_id=%s index=%s", request_id, section.index)
    except Exception:
        logger.exception("gemma: suggest_for_section task crashed")
    finally:
        # Always respond so the UI can clear its pending spinner.
        try:
            await ws_manager.send(
                GemmaSuggestion(
                    requestId=request_id,
                    sectionIndex=section.index,
                    highlights=highlights,
                )
            )
        except Exception:
            logger.exception("gemma: failed to send suggestion websocket message")
