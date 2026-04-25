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


def _tool_def_text(tool: dict) -> tuple[str, str]:
    """Render an Anthropic tool definition as the same flat text the model
    will see in its prompt: name, description, and the JSON input_schema.
    Returns (preview_label, raw_text) so the frontend can show "Read tool" in
    tooltips while still letting the user inspect/edit the full schema in the
    editor.

    Spec: https://docs.anthropic.com/en/api/messages — `tools` array entries.
    """
    name = tool.get("name", "")
    description = tool.get("description", "") or ""
    schema = tool.get("input_schema", {})
    try:
        rendered_schema = json.dumps(schema, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        rendered_schema = str(schema)
    raw = f"[tool {name}]\n{description}\n\ninput_schema:\n{rendered_schema}"
    label = f"tool: {name}" if name else "tool"
    return label, raw


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

    # Tool definitions live in `body["tools"]` (per Anthropic Messages API),
    # not in `system` or `messages`. They typically account for thousands of
    # tokens in Claude Code sessions and were previously invisible to the
    # chart — meaning users paid for them but couldn't see or trim them.
    tools = body.get("tools", []) if isinstance(body, dict) else []
    if isinstance(tools, list):
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            label, raw = _tool_def_text(tool)
            tokens = tokenizer.count(raw)
            sections.append(
                Section(
                    index=next_index,
                    sectionType="tool_def",
                    tokenCount=tokens,
                    cost=pricing.section_cost(tokens, model),
                    contentPreview=_preview(label),
                    rawContent=raw,
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
