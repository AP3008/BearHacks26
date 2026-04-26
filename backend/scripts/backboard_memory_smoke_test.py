from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import httpx
from dotenv import load_dotenv


@dataclass(frozen=True)
class Env:
    base_url: str
    api_key: str
    assistant_id: str
    timeout_s: float


def _load_env(*, env_path: str) -> Env:
    load_dotenv(env_path, override=False)
    api_key = (os.getenv("BACKBOARD_API_KEY", "") or "").strip()
    assistant_id = (os.getenv("BACKBOARD_ASSISTANT_ID", "") or "").strip()
    base_url = (os.getenv("BACKBOARD_API_URL", "") or "").strip() or "https://app.backboard.io/api"
    base_url = base_url.rstrip("/")
    timeout_s = float(os.getenv("BACKBOARD_HTTP_TIMEOUT_S", "30"))

    if not api_key:
        raise SystemExit("Missing BACKBOARD_API_KEY")
    if not assistant_id:
        raise SystemExit("Missing BACKBOARD_ASSISTANT_ID")

    return Env(base_url=base_url, api_key=api_key, assistant_id=assistant_id, timeout_s=timeout_s)


def _expect_status(resp: httpx.Response, ok: set[int]) -> dict[str, Any]:
    if resp.status_code not in ok:
        body = (resp.text or "").strip()
        raise RuntimeError(f"HTTP {resp.status_code} body={body[:1200]}")
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected response shape: {type(data)}")
    return data


def main() -> None:
    env_path = sys.argv[1] if len(sys.argv) > 1 else "backend/.env"
    e = _load_env(env_path=env_path)

    now_ms = int(time.time() * 1000)
    memory_content = f"[smoke_test] created_at_ms={now_ms} preference=user likes dark mode"
    message_content = "What do you remember about my UI preferences?"

    with httpx.Client(
        base_url=e.base_url,
        headers={"X-API-Key": e.api_key},
        timeout=e.timeout_s,
    ) as c:
        # 1) Create thread under assistant
        r_thread = c.post(f"/assistants/{e.assistant_id}/threads", json={"metadata": {"source": "smoke_test"}})
        thread = _expect_status(r_thread, {200, 201})
        thread_id = thread.get("thread_id") or thread.get("id")
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise RuntimeError(f"Missing thread_id keys={list(thread.keys())}")

        # 2) Add manual memory
        r_mem = c.post(
            f"/assistants/{e.assistant_id}/memories",
            json={"content": memory_content, "metadata": {"source": "smoke_test", "created_at_ms": now_ms}},
        )
        mem = _expect_status(r_mem, {200, 201})
        memory_id = mem.get("memory_id") or mem.get("id")

        # 3) Add message with memory enabled (this is what should increment dashboard reads/writes)
        # Docs show form-encoded data for this endpoint.
        r_msg = c.post(
            f"/threads/{thread_id}/messages",
            data={"content": message_content, "stream": "false", "memory": "Auto"},
        )
        msg = _expect_status(r_msg, {200, 201})

    print("ok")
    print(f"thread_id={thread_id}")
    if isinstance(memory_id, str) and memory_id:
        print(f"memory_id={memory_id}")
    print(f"message_response_keys={sorted(msg.keys())}")


if __name__ == "__main__":
    main()

