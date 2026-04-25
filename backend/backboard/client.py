from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

_api_key: str = ""
_assistant_id: str = ""
_base_url: str = "https://app.backboard.io/api"
_client: Optional[httpx.AsyncClient] = None


def configure(
    *,
    api_key: str,
    assistant_id: str,
    base_url: str | None = None,
) -> None:
    global _api_key, _assistant_id, _base_url
    _api_key = (api_key or "").strip()
    _assistant_id = (assistant_id or "").strip()
    if base_url:
        _base_url = base_url.rstrip("/")


def is_configured() -> bool:
    return bool(_api_key and _assistant_id)


async def startup() -> None:
    global _client
    if not is_configured():
        logger.info("backboard: disabled (missing BACKBOARD_API_KEY or BACKBOARD_ASSISTANT_ID)")
        return
    timeout = float(os.getenv("BACKBOARD_HTTP_TIMEOUT_S", "30"))
    _client = httpx.AsyncClient(
        base_url=_base_url,
        headers={"X-API-Key": _api_key},
        timeout=timeout,
    )
    aid = _assistant_id
    logger.info(
        "backboard: client ready (assistant_id=%s)",
        (aid[:8] + "…") if len(aid) > 8 else aid,
    )


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _client_or_none() -> Optional[httpx.AsyncClient]:
    return _client if is_configured() else None


async def add_memory(*, content: str, metadata: dict[str, Any]) -> Optional[str]:
    c = _client_or_none()
    if c is None:
        return None
    resp = await c.post(
        f"/assistants/{_assistant_id}/memories",
        json={"content": content, "metadata": metadata},
    )
    if resp.status_code not in (200, 201):
        logger.warning(
            "backboard: add_memory HTTP %s body=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        return None
    data = resp.json()
    mid = data.get("memory_id") or data.get("id")
    if not isinstance(mid, str):
        logger.warning("backboard: add_memory missing id in response keys=%s", list(data.keys()))
        return None
    return mid


async def update_memory(*, memory_id: str, content: str, metadata: dict[str, Any]) -> bool:
    c = _client_or_none()
    if c is None:
        return False
    resp = await c.put(
        f"/assistants/{_assistant_id}/memories/{memory_id}",
        json={"content": content, "metadata": metadata},
    )
    if resp.status_code != 200:
        logger.warning(
            "backboard: update_memory HTTP %s id=%s body=%s",
            resp.status_code,
            memory_id[:16],
            (resp.text or "")[:400],
        )
        return False
    return True


async def search_memories(*, query: str, limit: int) -> list[dict[str, Any]]:
    c = _client_or_none()
    if c is None:
        return []
    resp = await c.post(
        f"/assistants/{_assistant_id}/memories/search",
        json={"query": query, "limit": max(1, min(limit, 50))},
    )
    if resp.status_code != 200:
        logger.warning(
            "backboard: search_memories HTTP %s body=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        return []
    data = resp.json()
    raw = data.get("memories")
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


async def create_thread(*, thread_metadata: dict[str, Any] | None = None) -> Optional[str]:
    """Create a Backboard thread under the configured assistant.

    Threads are useful for keeping conversations separated per user/session.
    """
    c = _client_or_none()
    if c is None:
        return None
    payload: dict[str, Any] = {}
    if thread_metadata:
        payload["metadata"] = thread_metadata
    resp = await c.post(f"/assistants/{_assistant_id}/threads", json=payload)
    if resp.status_code not in (200, 201):
        logger.warning(
            "backboard: create_thread HTTP %s body=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        return None
    data = resp.json()
    tid = data.get("thread_id") or data.get("id")
    return tid if isinstance(tid, str) else None
