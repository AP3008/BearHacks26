from __future__ import annotations

import json
from typing import Any

from models import Section

LARGE_SECTION_TOKENS = 2000

FLAGGING_SYSTEM = """You are a context-window auditor for a coding assistant. You receive a JSON list of conversation sections (system prompt, user messages, assistant replies, tool calls, tool outputs). Identify sections that are redundant, stale, or safe to remove without losing important context.

Return ONLY valid JSON. The output MUST be an object with a single key "flags" whose value is an array. Each entry in the array MUST have this exact shape:
{
  "sectionIndex": <integer>,
  "severity": "high" | "medium" | "low",
  "reason": "<short explanation>",
  "highlights": [{"start": <int>, "end": <int>}]
}

Rules:
- Only flag sections that are clearly removable. Do not flag the most recent user message. Do not flag the system prompt.
- "high" = clearly redundant or stale. "medium" = likely removable. "low" = possibly trimmable.
- "highlights" character ranges are optional; use [] if you don't have specific ranges.
- If nothing is flaggable, return {"flags": []}."""


SUGGESTION_SYSTEM = """You are a context-window auditor. You receive ONE section's full text plus the conversation goal. Identify specific character ranges within the section that can be removed without losing information needed for the goal.

Return ONLY valid JSON of the form:
{
  "highlights": [
    {"start": <int>, "end": <int>, "reason": "<short explanation>"}
  ]
}

Hard constraints:
- Output must start with "{" and end with "}" (no prose, no markdown, no code fences).
- Never ask the user questions. Never explain what tools are. Never restate the prompt.
- You MUST follow the schema even if the section is a tool definition / JSON schema.

Character offsets refer to the section text exactly as provided. If nothing is removable, return {"highlights": []}."""


SUGGESTION_SYSTEM_RETRY = """You are returning INVALID output. Fix it now.

Return ONLY a single JSON object. No prose, no markdown, no code fences.

Schema (must match exactly):
{"highlights":[{"start":0,"end":0,"reason":"..."}]}

Rules:
- Output must start with "{" and end with "}".
- If you cannot find anything removable, return {"highlights": []}.
- Do not include any keys other than "highlights" (and within it: start, end, reason)."""


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
    payload = [_section_for_prompt(s) for s in sections]
    return json.dumps({"sections": payload}, ensure_ascii=False)


def suggestion_user(section: Section, goal: str) -> str:
    payload = {
        "goal": goal,
        "section": {
            "index": section.index,
            "sectionType": section.sectionType,
            "rawContent": section.rawContent,
        },
    }
    return json.dumps(payload, ensure_ascii=False)
