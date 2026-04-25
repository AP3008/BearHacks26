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


def is_connected() -> bool:
    return _socket is not None


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


async def disconnect(ws: WebSocket) -> None:
    global _socket
    async with _lock:
        if _socket is ws:
            _socket = None
            logger.info("ws: client disconnected")


async def send(message: BaseModel | dict[str, Any]) -> None:
    sock = _socket
    if sock is None:
        logger.debug("ws: send dropped (no client)")
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
