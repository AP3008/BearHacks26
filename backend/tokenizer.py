from __future__ import annotations

import logging

import tiktoken

logger = logging.getLogger(__name__)

_ENC = tiktoken.get_encoding("cl100k_base")


def count(text: str) -> int:
    if not text:
        return 0
    return len(_ENC.encode(text, disallowed_special=()))
