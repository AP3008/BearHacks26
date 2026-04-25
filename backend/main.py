from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket

import forwarder
import gating
import interceptor
import ws_manager
from gemma import analyzer
from models import (
    Approve,
    ApproveModified,
    Cancel,
    InboundMessage,
    ModeChange,
    PauseToggle,
    RequestSuggestion,
)

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("contextlens")

ANTHROPIC_UPSTREAM_URL = os.getenv("ANTHROPIC_UPSTREAM_URL", "https://api.anthropic.com")
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:e4b")


@asynccontextmanager
async def lifespan(app: FastAPI):
    forwarder.configure(ANTHROPIC_UPSTREAM_URL)
    analyzer.configure(OLLAMA_HOST, OLLAMA_MODEL)
    await forwarder.startup()
    await analyzer.probe()
    logger.info(
        "contextlens proxy ready (upstream=%s, gemma_available=%s)",
        ANTHROPIC_UPSTREAM_URL,
        analyzer.is_available(),
    )
    try:
        yield
    finally:
        await forwarder.shutdown()


app = FastAPI(lifespan=lifespan)


async def _dispatch(msg: InboundMessage) -> None:
    if isinstance(msg, Approve):
        gating.resolve(msg.requestId, "approve")
    elif isinstance(msg, ApproveModified):
        gating.resolve(msg.requestId, "approve_modified", msg.removedIndices, msg.editedSections)
    elif isinstance(msg, Cancel):
        gating.resolve(msg.requestId, "cancel")
    elif isinstance(msg, ModeChange):
        gating.set_mode(msg.mode)
    elif isinstance(msg, PauseToggle):
        gating.set_pause(msg.paused)
    elif isinstance(msg, RequestSuggestion):
        sections = interceptor.recent_sections.get(msg.requestId, [])
        asyncio.create_task(analyzer.suggest(msg.requestId, msg.sectionIndex, sections))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await ws_manager.connect(websocket)
    await ws_manager.receive_loop(websocket, _dispatch)


@app.post("/v1/messages")
async def messages_endpoint(request: Request):
    return await interceptor.handle(request)


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def catchall(request: Request, full_path: str):
    return await forwarder.passthrough(request, full_path)
