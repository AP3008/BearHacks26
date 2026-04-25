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


def _classify_block(role: str, block: Any) -> tuple[SectionType, str]:
    """Classify a single message content block. Block-level granularity (vs.
    one-section-per-message) so a user message with `[text, tool_result]`
    becomes two editable sections instead of one collapsed string — and so
    apply_edits can update the right block without inventing structure that
    didn't exist."""
    if not isinstance(block, dict):
        # String content (when the entire message.content is a plain string)
        # or anything else we can flatten to text.
        text = _coerce_text(block)
        if role == "system":
            return "system", text
        if role == "assistant":
            return "assistant", text
        return "user", text

    btype = block.get("type")
    if btype == "text" and isinstance(block.get("text"), str):
        text = block["text"]
        if role == "assistant":
            return "assistant", text
        if role == "system":
            return "system", text
        return "user", text
    if btype == "tool_use":
        name = block.get("name", "")
        tool_input = block.get("input", {})
        try:
            rendered = json.dumps(tool_input, ensure_ascii=False)
        except (TypeError, ValueError):
            rendered = str(tool_input)
        return "tool_call", f"[tool_use {name}] {rendered}"
    if btype == "tool_result":
        return "tool_output", _coerce_text(block.get("content"))
    if btype == "image":
        # Anthropic image blocks: source is base64 or URL. We deliberately
        # don't render the bytes — just a sentinel so the user can see and
        # delete it. Edits don't round-trip into the structured source.
        return "image", "[image content]"
    return "unknown", _coerce_text(block)


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
            # Walk every slot (even non-dicts) so apply_edits stays in
            # lockstep — its walk does not skip non-dicts either.
            if isinstance(tool, dict):
                label, raw = _tool_def_text(tool)
            else:
                label, raw = "tool", _coerce_text(tool)
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

    for msg_idx, entry in enumerate(messages):
        # Per-block emission: a user message with [text, tool_result, tool_result]
        # becomes three sections (one editable text, two editable tool outputs).
        # Without this, structural fidelity is lost when the user edits — see
        # the broken tool_call edit case where a text block was silently
        # prepended to an assistant tool_use message.
        if not isinstance(entry, dict):
            # Non-dict at message position — emit a single placeholder so
            # apply_edits' walk stays aligned with this index.
            raw = _coerce_text(entry)
            tokens = tokenizer.count(raw)
            sections.append(
                Section(
                    index=next_index,
                    sectionType="unknown",
                    tokenCount=tokens,
                    cost=pricing.section_cost(tokens, model),
                    contentPreview=_preview(raw),
                    rawContent=raw,
                    messageIndex=msg_idx,
                )
            )
            next_index += 1
            continue

        role = entry.get("role", "")
        content = entry.get("content")

        if isinstance(content, list):
            for block in content:
                section_type, raw = _classify_block(role, block)
                tokens = tokenizer.count(raw)
                sections.append(
                    Section(
                        index=next_index,
                        sectionType=section_type,
                        tokenCount=tokens,
                        cost=pricing.section_cost(tokens, model),
                        contentPreview=_preview(raw),
                        rawContent=raw,
                        messageIndex=msg_idx,
                    )
                )
                next_index += 1
        else:
            # String content (or None) — one section for the whole message.
            section_type, raw = _classify_block(role, content)
            tokens = tokenizer.count(raw)
            sections.append(
                Section(
                    index=next_index,
                    sectionType=section_type,
                    tokenCount=tokens,
                    cost=pricing.section_cost(tokens, model),
                    contentPreview=_preview(raw),
                    rawContent=raw,
                    messageIndex=msg_idx,
                )
            )
            next_index += 1

    total_tokens = sum(s.tokenCount for s in sections)
    total_cost = sum(s.cost for s in sections)
    return sections, total_tokens, total_cost, model
