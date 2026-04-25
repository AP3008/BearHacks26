from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-4-7": (15.00, 75.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (0.80, 4.00),
}
DEFAULT: tuple[float, float] = (3.00, 15.00)


def _lookup(model: str) -> tuple[float, float]:
    if model in PRICING:
        return PRICING[model]
    for key, rate in PRICING.items():
        if model.startswith(key):
            return rate
    return DEFAULT


def input_rate(model: str) -> float:
    return _lookup(model)[0]


def output_rate(model: str) -> float:
    return _lookup(model)[1]


def section_cost(tokens: int, model: str) -> float:
    return tokens / 1_000_000 * input_rate(model)
