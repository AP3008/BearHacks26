from __future__ import annotations

import json
from typing import Any

from models import Section

LARGE_SECTION_TOKENS = 2000

FLAGGING_SYSTEM = """You are a context prompt reviewer for a prompt engineer. You recieve a section of text that is either a user prompt, assistant response, tool call or tool output. This section inputted to you is a part of a larger conversation.
You will flag parts within the section that are redundant, stale, or safe to remove without losing important context.

Return ONLY valid JSON. The output MUST be an object with a single key "flags" whose value is an array. Each entry in the array MUST have this exact shape:
{
  "severity": "high" | "medium" | "low",
  "highlights": [{"start": <int>, "end": <int>}]
}

Rules:
- "high" = clearly redundant or stale. "medium" = likely removable. "low" = possibly trimmable.
- If nothing is flaggable, return {"flags": []}."""


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
    # Keep the system prompt unchanged: it expects "a section of text".
    # We therefore feed only rawContent for the single section we’re flagging.
    if not sections:
        return ""
    return sections[0].rawContent
