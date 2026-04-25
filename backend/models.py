from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


SectionType = Literal["system", "user", "assistant", "tool_call", "tool_output", "unknown"]
Severity = Literal["high", "medium", "low"]


class Section(BaseModel):
    index: int
    sectionType: SectionType
    tokenCount: int
    cost: float
    contentPreview: str
    rawContent: str


class NewRequest(BaseModel):
    type: Literal["new_request"] = "new_request"
    requestId: str
    sections: list[Section]
    totalTokens: int
    totalCost: float
    model: str


class Highlight(BaseModel):
    start: int
    end: int


class GemmaFlag(BaseModel):
    sectionIndex: int
    severity: Severity
    reason: str
    highlights: list[Highlight] = Field(default_factory=list)


class GemmaFlags(BaseModel):
    type: Literal["gemma_flags"] = "gemma_flags"
    requestId: str
    flags: list[GemmaFlag]


class SuggestionHighlight(BaseModel):
    start: int
    end: int
    reason: str


class GemmaSuggestion(BaseModel):
    type: Literal["gemma_suggestion"] = "gemma_suggestion"
    requestId: str
    sectionIndex: int
    highlights: list[SuggestionHighlight]


class TimeoutWarning(BaseModel):
    type: Literal["timeout_warning"] = "timeout_warning"
    requestId: str


class Approve(BaseModel):
    type: Literal["approve"]
    requestId: str


class EditedSection(BaseModel):
    index: int
    newContent: str


class ApproveModified(BaseModel):
    type: Literal["approve_modified"]
    requestId: str
    removedIndices: list[int] = Field(default_factory=list)
    editedSections: list[EditedSection] = Field(default_factory=list)


class Cancel(BaseModel):
    type: Literal["cancel"]
    requestId: str


class ModeChange(BaseModel):
    type: Literal["mode_change"]
    mode: Literal["auto_send", "ask_permission"]


class PauseToggle(BaseModel):
    type: Literal["pause_toggle"]
    paused: bool


class RequestSuggestion(BaseModel):
    type: Literal["request_suggestion"]
    requestId: str
    sectionIndex: int


InboundMessage = Annotated[
    Union[Approve, ApproveModified, Cancel, ModeChange, PauseToggle, RequestSuggestion],
    Field(discriminator="type"),
]
