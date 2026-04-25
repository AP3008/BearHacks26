from __future__ import annotations

import hashlib


def normalize_text(text: str) -> str:
    flat = " ".join(text.split()).strip()
    return flat[:50000]


def slot_message_key(*, session_id: str, index: int, section_type: str, raw_content: str) -> str:
    norm = normalize_text(raw_content)
    payload = f"{session_id}\x00{index}\x00{section_type}\x00{norm}".encode("utf-8", errors="replace")
    return hashlib.sha256(payload).hexdigest()
