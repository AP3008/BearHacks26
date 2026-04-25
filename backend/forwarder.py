from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

import gating

logger = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None
_upstream: str = "https://api.anthropic.com"

_HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding"}


def configure(upstream_url: str) -> None:
    global _upstream
    _upstream = upstream_url.rstrip("/")


async def startup() -> None:
    global _client
    _client = httpx.AsyncClient(timeout=None)


async def shutdown() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _filter_request_headers(headers: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


def _filter_response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


def _client_or_raise() -> httpx.AsyncClient:
    if _client is None:
        raise RuntimeError("forwarder not initialized")
    return _client


async def forward_messages(body: dict[str, Any], headers: dict[str, str]) -> Response:
    url = f"{_upstream}/v1/messages"
    # Defensive net: even on paths that didn't go through apply_edits (aux
    # calls, canonical/incoming drift across sessions) we must not ship a
    # tool_result whose tool_use_id has no match in the prior assistant turn —
    # Anthropic rejects the request with HTTP 400 and the conversation aborts.
    body = gating.prune_orphan_tool_pairs(body)
    payload = json.dumps(body).encode("utf-8")
    fwd_headers = _filter_request_headers(headers)
    fwd_headers["content-type"] = "application/json"

    client = _client_or_raise()
    try:
        req = client.build_request("POST", url, content=payload, headers=fwd_headers)
        upstream = await client.send(req, stream=True)
    except (httpx.ConnectError, httpx.TransportError) as exc:
        logger.warning("forwarder: upstream connection error: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": {"type": "proxy_upstream_error", "message": str(exc)}},
        )

    async def body_iter() -> AsyncIterator[bytes]:
        gating.stream_in_flight += 1
        decremented = False

        def _release() -> None:
            nonlocal decremented
            if not decremented:
                gating.stream_in_flight = max(0, gating.stream_in_flight - 1)
                decremented = True

        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except (httpx.ReadError, httpx.RemoteProtocolError) as exc:
            logger.warning("forwarder: upstream stream broke: %s", exc)
        finally:
            # Decrement first — if aclose() blocks or raises, we still don't
            # want stream_in_flight to leak, otherwise Gemma's _wait_for_idle
            # spins forever.
            _release()
            try:
                await upstream.aclose()
            except Exception:
                pass

    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=_filter_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )


async def passthrough(request: Request, full_path: str) -> Response:
    # Forensic trail for "what reached Anthropic that the user couldn't see":
    # the catch-all covers /v1/files, /v1/messages/batches, model-listing,
    # token-counting, and anything else Claude Code (or another client) calls
    # outside /v1/messages. We don't gate these — schemas vary too much — but
    # we surface them in the proxy log so the user has a record. WARNING level
    # so they stand out in the ContextLens output channel.
    logger.warning(
        "forwarder: passthrough %s /%s — forwarded transparently, not gated",
        request.method,
        full_path,
    )
    url = f"{_upstream}/{full_path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    body = await request.body()
    fwd_headers = _filter_request_headers(dict(request.headers))

    client = _client_or_raise()
    try:
        req = client.build_request(request.method, url, content=body, headers=fwd_headers)
        upstream = await client.send(req, stream=True)
    except (httpx.ConnectError, httpx.TransportError) as exc:
        logger.warning("forwarder: passthrough upstream error: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": {"type": "proxy_upstream_error", "message": str(exc)}},
        )

    async def body_iter() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=_filter_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )
