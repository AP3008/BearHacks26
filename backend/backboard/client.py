from __future__ import annotations

import asyncio
import logging
import os
import random
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
        logger.debug("backboard: disabled (missing BACKBOARD_API_KEY or BACKBOARD_ASSISTANT_ID)")
        return
    timeout = float(os.getenv("BACKBOARD_HTTP_TIMEOUT_S", "30"))
    _client = httpx.AsyncClient(
        base_url=_base_url,
        headers={"X-API-Key": _api_key},
        timeout=timeout,
    )
    aid = _assistant_id
    logger.debug(
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


def _retry_max_attempts() -> int:
    try:
        return max(1, min(8, int(os.getenv("BACKBOARD_RETRY_MAX_ATTEMPTS", "4"))))
    except ValueError:
        return 4


def _retry_base_delay_s() -> float:
    try:
        return max(0.05, float(os.getenv("BACKBOARD_RETRY_BASE_DELAY_S", "0.4")))
    except ValueError:
        return 0.4


def _retry_max_delay_s() -> float:
    try:
        return max(0.1, float(os.getenv("BACKBOARD_RETRY_MAX_DELAY_S", "8.0")))
    except ValueError:
        return 8.0


def _is_retryable_status(status_code: int) -> bool:
    return status_code == 429 or status_code in (500, 502, 503, 504)


def _retry_after_s(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


async def _request_with_retry(
    *,
    request_name: str,
    send: "callable[[], Any]",
    context: dict[str, Any] | None = None,
) -> Optional[httpx.Response]:
    max_attempts = _retry_max_attempts()
    base_delay_s = _retry_base_delay_s()
    max_delay_s = _retry_max_delay_s()

    last_exc: Exception | None = None
    last_status: int | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = await send()
            if not _is_retryable_status(resp.status_code):
                return resp

            last_status = resp.status_code
            body_preview = (resp.text or "")[:400]
            logger.debug(
                "backboard: %s retryable HTTP %s attempt=%s/%s body=%s ctx=%s",
                request_name,
                resp.status_code,
                attempt,
                max_attempts,
                body_preview,
                context or {},
            )
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            last_exc = e
            logger.debug(
                "backboard: %s network error attempt=%s/%s err=%s ctx=%s",
                request_name,
                attempt,
                max_attempts,
                repr(e),
                context or {},
            )

        if attempt >= max_attempts:
            break

        # Prefer server-provided backoff when present, otherwise full-jitter exponential.
        retry_after_s = _retry_after_s(resp) if "resp" in locals() else None
        if retry_after_s is not None and retry_after_s > 0:
            await asyncio.sleep(min(max_delay_s, retry_after_s))
        else:
            exp = base_delay_s * (2 ** (attempt - 1))
            delay_s = min(max_delay_s, exp)
            await asyncio.sleep(random.random() * delay_s)

    if last_exc:
        logger.debug(
            "backboard: %s giving up after %s attempts err=%s",
            request_name,
            max_attempts,
            repr(last_exc),
        )
    if last_status is not None:
        logger.debug(
            "backboard: %s giving up after %s attempts last_http=%s ctx=%s",
            request_name,
            max_attempts,
            last_status,
            context or {},
        )
    return None


async def add_memory(*, content: str, metadata: dict[str, Any]) -> Optional[str]:
    c = _client_or_none()
    if c is None:
        return None
    ctx = {
        "content_len": len(content or ""),
        "kind": metadata.get("kind"),
        "request_id": metadata.get("request_id"),
        "section_index": metadata.get("section_index"),
        "section_type": metadata.get("section_type"),
    }
    resp = await _request_with_retry(
        request_name="add_memory",
        send=lambda: c.post(
            f"/assistants/{_assistant_id}/memories",
            json={"content": content, "metadata": metadata},
        ),
        context=ctx,
    )
    if resp is None:
        return None
    if resp.status_code not in (200, 201):
        logger.debug(
            "backboard: add_memory HTTP %s body=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        return None
    data = resp.json()
    mid = data.get("memory_id") or data.get("id")
    if not isinstance(mid, str):
        logger.debug("backboard: add_memory missing id in response keys=%s", list(data.keys()))
        return None
    return mid


async def update_memory(*, memory_id: str, content: str, metadata: dict[str, Any]) -> bool:
    c = _client_or_none()
    if c is None:
        return False
    resp = await _request_with_retry(
        request_name="update_memory",
        send=lambda: c.put(
            f"/assistants/{_assistant_id}/memories/{memory_id}",
            json={"content": content, "metadata": metadata},
        ),
    )
    if resp is None:
        return False
    if resp.status_code != 200:
        logger.debug(
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
    resp = await _request_with_retry(
        request_name="search_memories",
        send=lambda: c.post(
            f"/assistants/{_assistant_id}/memories/search",
            json={"query": query, "limit": max(1, min(limit, 50))},
        ),
    )
    if resp is None:
        return []
    if resp.status_code != 200:
        logger.debug(
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
    resp = await _request_with_retry(
        request_name="create_thread",
        send=lambda: c.post(f"/assistants/{_assistant_id}/threads", json=payload),
    )
    if resp is None:
        return None
    if resp.status_code not in (200, 201):
        logger.debug(
            "backboard: create_thread HTTP %s body=%s",
            resp.status_code,
            (resp.text or "")[:400],
        )
        return None
    data = resp.json()
    tid = data.get("thread_id") or data.get("id")
    return tid if isinstance(tid, str) else None
