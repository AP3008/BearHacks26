"""Anthropic `cache_control` count cap — no FastAPI; safe for unit tests to import."""

from __future__ import annotations

from typing import Any


def strip_excess_cache_control(
    body: dict[str, Any], max_blocks: int = 4
) -> tuple[dict[str, Any], int]:
    """Anthropic enforces a hard cap on the number of blocks containing
    `cache_control` across the entire request. Some upstream clients (e.g. IDE
    agents) can exceed this, which causes a 400.

    We keep the first `max_blocks` occurrences (in a stable traversal order)
    and remove `cache_control` from any additional blocks.
    """

    def _walk(value: Any, state: dict[str, int]) -> None:
        if isinstance(value, dict):
            if "cache_control" in value:
                state["seen"] += 1
                if state["seen"] > max_blocks:
                    value.pop("cache_control", None)
                    state["stripped"] += 1
            for v in value.values():
                _walk(v, state)
            return
        if isinstance(value, list):
            for item in value:
                _walk(item, state)
            return

    state = {"seen": 0, "stripped": 0}
    _walk(body, state)
    return body, state["stripped"]
