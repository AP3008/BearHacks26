from __future__ import annotations

import json
from typing import Any

from models import Section

LARGE_SECTION_TOKENS = 2000

# Ollama `format` for strict flagging output (JSON Schema). Matches FLAGGING_SYSTEM shape.
FLAGGING_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["flags"],
    "properties": {
        "flags": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["severity", "highlights"],
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                    "highlights": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["start", "end"],
                            "properties": {
                                "start": {"type": "integer"},
                                "end": {"type": "integer"},
                            },
                            "additionalProperties": False,
                        },
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    "additionalProperties": False,
}

FLAGGING_SYSTEM = """You are a context prompt reviewer for a prompt engineer. You recieve a section of text that is either a user prompt, assistant response, tool call or tool output. This section inputted to you is a part of a larger conversation.
You will flag parts within the section that are redundant, stale, or safe to remove without losing important context.
You will also flag things that are unrelated to coding or the conversation goal.

You will be loose on the flags, you may flag anything that shows a small amount of issue.

Return ONLY valid JSON. The output MUST be an object with a single key "flags" whose value is an array. Each entry in the array MUST have this exact shape:
{
  "severity": "high" | "medium" | "low",
  "highlights": [{"start": <int>, "end": <int>}]
}

Rules:
- "high" = clearly redundant or stale. "medium" = likely removable. "low" = possibly trimmable.
- You will flag things that are deemed low, medium or high severity.
- If nothing is flaggable, return {"flags": []}."""


def format_gemma4_dialogue(*, system: str, user: str) -> str:
    """Format a single-turn dialogue using Gemma 4 control tokens.

    Ref: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
    """
    # IMPORTANT: We keep system/user content as-is; the separation is enforced
    # by Gemma's reserved control tokens.
    return "\n".join(
        [
            "<|turn>system",
            system.rstrip(),
            "<turn|>",
            "<|turn>user",
            user.rstrip(),
            "<turn|>",
            "<|turn>model",
        ]
    )


def _section_for_prompt(section: Section) -> dict[str, Any]:
    base = {
        "index": section.index,
        "sectionType": section.sectionType,
        "tokenCount": section.tokenCount,
        "contentPreview": section.contentPreview,
    }
    if section.tokenCount <= LARGE_SECTION_TOKENS:
        base["rawContent"] = section.rawContent
    return base


def flagging_user(sections: list[Section]) -> str:
    # JSON user payload: section text is a separate field so it is clearly data, not instructions.
    if not sections:
        return ""
    section = sections[0]
    payload: dict[str, Any] = {
        "task": "Flag removable character ranges in section_text. Output only the JSON object required by the system message.",
        "untrusted": True,
        "section_type": section.sectionType,
        "section_text": section.rawContent,
    }
    return json.dumps(payload, ensure_ascii=False)
