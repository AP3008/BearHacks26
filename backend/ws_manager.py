from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Optional

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ValidationError

from models import InboundMessage

logger = logging.getLogger(__name__)

_socket: Optional[WebSocket] = None
_lock = asyncio.Lock()

# Snapshot builder is registered by main.py once gating + analyzer are wired.
# It returns a pydantic model (or dict) that fully describes proxy state, so
# a freshly-attached panel can resume mid-flight instead of seeing a blank
# chart and a held request frozen in the proxy.
SnapshotBuilder = Callable[[], BaseModel | dict[str, Any] | None]
_snapshot_builder: Optional[SnapshotBuilder] = None


def is_connected() -> bool:
    return _socket is not None


def register_snapshot_builder(builder: SnapshotBuilder) -> None:
    global _snapshot_builder
    _snapshot_builder = builder


async def _send_snapshot(ws: WebSocket) -> None:
    if _snapshot_builder is None:
        return
    try:
        snap = _snapshot_builder()
    except Exception:
        logger.exception("ws: snapshot builder crashed")
        return
    if snap is None:
        return
    payload = snap.model_dump(mode="json") if isinstance(snap, BaseModel) else snap
    try:
        await ws.send_text(json.dumps(payload))
    except Exception as exc:
        logger.warning("ws: snapshot send failed: %s", exc)


async def broadcast_snapshot() -> None:
    """Push a fresh snapshot to the connected panel. Used when out-of-band
    state changes (Gemma availability flipping when Ollama comes online or
    crashes) need to reach the UI without waiting for the next reconnect."""
    sock = _socket
    if sock is None:
        return
    await _send_snapshot(sock)


async def connect(ws: WebSocket) -> None:
    global _socket
    await ws.accept()
    async with _lock:
        old = _socket
        _socket = ws
    if old is not None:
        try:
            await old.close(code=1000, reason="superseded")
        except Exception:
            pass
        logger.info("ws: superseded previous connection")
    logger.info("ws: client connected")
    # Always replay current state — without this, a panel that opens after
    # Claude Code already sent a request (or a panel that reconnects while a
    # request is still held) sees nothing and the proxy hangs.
    await _send_snapshot(ws)


async def disconnect(ws: WebSocket) -> None:
    global _socket
    async with _lock:
        if _socket is ws:
            _socket = None
            logger.info("ws: client disconnected")


async def send(message: BaseModel | dict[str, Any]) -> None:
    sock = _socket
    if sock is None:
        # No silent loss: anything important should be in the snapshot so a
        # late-joining client can recover. We log at debug because Gemma
        # flags etc. legitimately fire when no UI is attached.
        logger.debug("ws: send dropped (no client) type=%s",
                     getattr(message, "type", None) if isinstance(message, BaseModel) else type(message).__name__)
        return
    if isinstance(message, BaseModel):
        payload = message.model_dump(mode="json")
    else:
        payload = message
    try:
        await sock.send_text(json.dumps(payload))
    except Exception as exc:
        logger.warning("ws: send failed: %s", exc)


Dispatcher = Callable[[InboundMessage], Awaitable[None]]


async def receive_loop(ws: WebSocket, dispatcher: Dispatcher) -> None:
    from pydantic import TypeAdapter

    adapter = TypeAdapter(InboundMessage)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("ws: bad json from client")
                continue
            try:
                msg = adapter.validate_python(payload)
            except ValidationError as exc:
                logger.warning("ws: invalid inbound message: %s", exc)
                continue
            try:
                await dispatcher(msg)
            except Exception:
                logger.exception("ws: dispatcher error")
    except WebSocketDisconnect:
        pass
    finally:
        await disconnect(ws)
