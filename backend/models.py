from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field


SectionType = Literal[
    "system",
    "tool_def",
    "user",
    "assistant",
    "tool_call",
    "tool_output",
    "unknown",
]
Severity = Literal["high", "medium", "low"]
Mode = Literal["auto_send", "ask_permission"]
RequestKind = Literal["top_level", "tool_chain"]


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
    held: bool = False
    # Extras to make the request picker readable. `kind` is "tool_chain" if
    # this is a continuation of a tool-use loop, otherwise "top_level". The
    # preview is the last user-visible message text so the user can tell at a
    # glance whether this is "tell me about dinosaurs" or Claude Code's
    # auxiliary title-generation call.
    kind: RequestKind = "top_level"
    lastUserPreview: str = ""
    createdAt: float = 0.0


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


class GemmaUnavailable(BaseModel):
    type: Literal["gemma_unavailable"] = "gemma_unavailable"


class Snapshot(BaseModel):
    """Sent on every WebSocket connect so a freshly-opened panel can resume.

    Carries the proxy's authoritative mode/pause state and any request
    currently being held for approval — without this, reopening the panel
    while a request is held leaves the user with no Send button and Claude
    Code hangs until its internal timeout."""

    type: Literal["snapshot"] = "snapshot"
    mode: Mode
    paused: bool
    gemmaAvailable: bool
    pendingRequest: Optional[NewRequest] = None
    latestRequest: Optional[NewRequest] = None
    # Recent history (oldest first) so a freshly-attached panel can show a
    # full request picker, not just the most recent call.
    recentRequests: list[NewRequest] = Field(default_factory=list)


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


class ResetCanonical(BaseModel):
    type: Literal["reset_canonical"]


InboundMessage = Annotated[
    Union[
        Approve,
        ApproveModified,
        Cancel,
        ModeChange,
        PauseToggle,
        RequestSuggestion,
        ResetCanonical,
    ],
    Field(discriminator="type"),
]
