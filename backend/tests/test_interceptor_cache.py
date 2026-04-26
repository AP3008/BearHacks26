"""Regression tests for Anthropic `cache_control` cap enforcement."""

from __future__ import annotations

import copy
import unittest
from typing import Any

import cache_control_cap


def _count_cache_control(obj: Any) -> int:
    n = 0
    if isinstance(obj, dict):
        if "cache_control" in obj:
            n += 1
        for v in obj.values():
            n += _count_cache_control(v)
    elif isinstance(obj, list):
        for item in obj:
            n += _count_cache_control(item)
    return n


def _synthetic_body_with_n_cache_blocks(n: int) -> dict[str, Any]:
    """Build a /v1/messages-shaped body with `n` text blocks, each with cache_control."""
    blocks: list[dict[str, Any]] = []
    for i in range(n):
        blocks.append(
            {
                "type": "text",
                "text": f"section-{i}",
                "cache_control": {"type": "ephemeral"},
            }
        )
    return {
        "model": "claude-sonnet-4-5",
        "max_tokens": 1024,
        "tools": [{"name": "dummy", "input_schema": {"type": "object", "properties": {}}}],
        "messages": [{"role": "user", "content": blocks}],
    }


class TestStripExcessCacheControl(unittest.TestCase):
    def test_reduces_to_at_most_four(self) -> None:
        body = _synthetic_body_with_n_cache_blocks(6)
        self.assertEqual(_count_cache_control(body), 6)
        out, stripped = cache_control_cap.strip_excess_cache_control(copy.deepcopy(body), max_blocks=4)
        self.assertEqual(stripped, 2)
        self.assertLessEqual(_count_cache_control(out), 4)
        self.assertEqual(_count_cache_control(out), 4)

    def test_unchanged_when_four_or_fewer(self) -> None:
        body = _synthetic_body_with_n_cache_blocks(4)
        out, stripped = cache_control_cap.strip_excess_cache_control(copy.deepcopy(body), max_blocks=4)
        self.assertEqual(stripped, 0)
        self.assertEqual(_count_cache_control(out), 4)

    def test_merged_excess_merged_scenario_still_capped(self) -> None:
        """Simulate canonical (4 blocks) + new tail (2) without running sync()."""
        base = _synthetic_body_with_n_cache_blocks(4)
        extra = _synthetic_body_with_n_cache_blocks(2)
        user_blocks = (base["messages"][0]["content"] or []) + (extra["messages"][0]["content"] or [])
        merged = {
            "model": base["model"],
            "max_tokens": base["max_tokens"],
            "tools": base["tools"],
            "messages": [{"role": "user", "content": user_blocks}],
        }
        self.assertEqual(_count_cache_control(merged), 6)
        out, _ = cache_control_cap.strip_excess_cache_control(copy.deepcopy(merged), max_blocks=4)
        self.assertEqual(_count_cache_control(out), 4)


if __name__ == "__main__":
    unittest.main()
