from __future__ import annotations

import json
import logging
from typing import Any

import pricing
import tokenizer
from models import Section, SectionType

logger = logging.getLogger(__name__)


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for block in value:
            if isinstance(block, dict):
                if "text" in block and isinstance(block["text"], str):
                    parts.append(block["text"])
                elif block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
        return "\n".join(parts)
    return str(value)


def _system_text(system: Any) -> str:
    return _coerce_text(system)


def _classify_message(role: str, content: Any) -> tuple[SectionType, str]:
    if isinstance(content, str):
        if role == "system":
            return "system", content
        if role == "assistant":
            return "assistant", content
        return "user", content

    if not isinstance(content, list):
        return "unknown", _coerce_text(content)

    has_tool_use = False
    has_tool_result = False
    text_parts: list[str] = []
    tool_parts: list[str] = []

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text" and isinstance(block.get("text"), str):
            text_parts.append(block["text"])
        elif btype == "tool_use":
            has_tool_use = True
            name = block.get("name", "")
            tool_input = block.get("input", {})
            try:
                rendered = json.dumps(tool_input, ensure_ascii=False)
            except (TypeError, ValueError):
                rendered = str(tool_input)
            tool_parts.append(f"[tool_use {name}] {rendered}")
        elif btype == "tool_result":
            has_tool_result = True
            inner = block.get("content")
            tool_parts.append(f"[tool_result] {_coerce_text(inner)}")

    raw = "\n".join(p for p in text_parts + tool_parts if p)

    if role == "user" and has_tool_result:
        return "tool_output", raw
    if role == "assistant" and has_tool_use:
        return "tool_call", raw
    if role == "user":
        return "user", raw
    if role == "assistant":
        return "assistant", raw
    if role == "system":
        return "system", raw
    return "unknown", raw


def _preview(text: str) -> str:
    flat = " ".join(text.split())
    return flat[:80]


def classify(body: dict) -> tuple[list[Section], int, float, str]:
    model = body.get("model", "claude-sonnet-4-6") if isinstance(body, dict) else "claude-sonnet-4-6"
    sections: list[Section] = []
    next_index = 0

    system_raw = _system_text(body.get("system")) if isinstance(body, dict) else ""
    if system_raw:
        tokens = tokenizer.count(system_raw)
        sections.append(
            Section(
                index=next_index,
                sectionType="system",
                tokenCount=tokens,
                cost=pricing.section_cost(tokens, model),
                contentPreview=_preview(system_raw),
                rawContent=system_raw,
            )
        )
        next_index += 1

    messages = body.get("messages", []) if isinstance(body, dict) else []
    if not isinstance(messages, list):
        messages = []

    for entry in messages:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role", "")
        content = entry.get("content")
        section_type, raw = _classify_message(role, content)
        tokens = tokenizer.count(raw)
        sections.append(
            Section(
                index=next_index,
                sectionType=section_type,
                tokenCount=tokens,
                cost=pricing.section_cost(tokens, model),
                contentPreview=_preview(raw),
                rawContent=raw,
            )
        )
        next_index += 1

    total_tokens = sum(s.tokenCount for s in sections)
    total_cost = sum(s.cost for s in sections)
    return sections, total_tokens, total_cost, model
