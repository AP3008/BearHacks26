from __future__ import annotations

import json
from typing import Any, Optional

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

FLAGGING_SYSTEM = """You are a context prompt reviewer for a prompt engineer. Flag ANY parts of the section that can be trimmed, removed, or condensed without losing critical information.

Your job is to be AGGRESSIVE. Flag liberally and extensively. Better to flag too much than too little.

Flag text that is:
- Redundant or repetitive
- Stale or outdated information
- Filler, fluff, or unnecessary elaboration
- Unrelated to the core task or coding
- Verbose when it could be concise
- Examples that don't add value
- Explanatory text that restates obvious things
- Any content that could reasonably be cut

Return ONLY valid JSON. The output MUST be an object with a single key "flags" whose value is an ARRAY of flag objects.

Each flag object in the array MUST have this exact shape:
{
  "severity": "high" | "medium" | "low",
  "highlights": [{"start": <int>, "end": <int>}]
}

IMPORTANT: You MUST return MULTIPLE flags. Each separate flaggable piece of text gets its own entry in the "flags" array.

Severity levels:
- "high" = clearly safe to remove (redundant, stale, off-topic)
- "medium" = probably removable (verbose, could be shortened)
- "low" = possibly trimmable (borderline, but could go)

Rules:
- "start" and "end" are 0-indexed character offsets into the text between ---BEGIN SECTION_TEXT--- and ---END SECTION_TEXT--- delimiters ONLY.
- Flag ALL removable ranges. Flag liberally and extensively.
- RETURN MULTIPLE FLAGS. Expect to return 3-10+ flags typically. Not just one.
- Each flaggable phrase/sentence/paragraph gets its own flag object with its own severity and highlights.
- A single flag object CAN span large ranges (paragraphs, multiple sentences).
- If nothing is flaggable, return {"flags": []}.
- Do not cut a word midway. You must either flag the whole word or none of it.

Example 1:
Section type: assistant
---BEGIN SECTION_TEXT---
Sure thing! Here's what I found:

The weather in Toronto is 15°C and sunny today.
---END SECTION_TEXT---

Example 1 output (MULTIPLE flags):
{"flags": [
  {"severity": "low", "highlights": [{"start": 0, "end": 14}]},
  {"severity": "high", "highlights": [{"start": 16, "end": 27}]},
  {"severity": "high", "highlights": [{"start": 28, "end": 64}]}
]}

Example 2 (aggressive - shows many flags):
Section type: assistant
---BEGIN SECTION_TEXT---
Let me help you with that. So basically, the main idea is this. First of all, I want to explain something. The concept here is that when you use Python, it's a programming language. Python is used for coding. You can write code in Python. Some people use Python a lot.

Here's the actual code:
x = 5
---END SECTION_TEXT---

Example 2 output (MULTIPLE flags - notice many separate flags):
{"flags": [
  {"severity": "high", "highlights": [{"start": 0, "end": 27}]},
  {"severity": "high", "highlights": [{"start": 28, "end": 75}]},
  {"severity": "high", "highlights": [{"start": 76, "end": 145}]},
  {"severity": "medium", "highlights": [{"start": 146, "end": 192}]},
  {"severity": "high", "highlights": [{"start": 193, "end": 237}]},
  {"severity": "high", "highlights": [{"start": 238, "end": 280}]}
]}"""


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


def flagging_user(
    sections: list[Section],
    *,
    prior_memories: Optional[list[dict[str, Any]]] = None,
) -> str:
    if not sections:
        return ""
    section = sections[0]
    return (
        f"Section type: {section.sectionType}\n"
        f"---BEGIN SECTION_TEXT---\n"
        f"{section.rawContent}\n"
        if prior_memories:
        payload["prior_conversation_excerpts"] = prior_memories[:8]
    f"---END SECTION_TEXT---"
    )