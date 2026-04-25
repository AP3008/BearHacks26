// Canonical message contracts shared with the proxy / extension host.
// Keep these byte-for-byte aligned with PRD §9 — do not redefine elsewhere.

export type SectionType =
  | "system"
  | "tool_def"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_output"
  | "image"
  | "unknown";

export interface Section {
  index: number;
  sectionType: SectionType;
  tokenCount: number;
  cost: number;
  contentPreview: string;
  rawContent: string;
  // Index of the parent message in body.messages, or -1 for system / tool_def
  // / string-content slots that don't belong to a list-content message. Used
  // by the bar chart to keep multi-block messages on the same turn.
  messageIndex?: number;
}

export type RequestKind = "top_level" | "tool_chain";

export interface NewRequest {
  type: "new_request";
  requestId: string;
  sections: Section[];
  totalTokens: number;
  totalCost: number;
  model: string;
  held?: boolean;
  kind?: RequestKind;
  lastUserPreview?: string;
  createdAt?: number;
}

export interface GemmaFlag {
  sectionIndex: number;
  severity: "high" | "medium" | "low";
  reason: string;
  highlights: Array<{ start: number; end: number }>;
}

export interface GemmaFlags {
  type: "gemma_flags";
  requestId: string;
  flags: GemmaFlag[];
}

export interface SuggestionHighlight {
  start: number;
  end: number;
  reason: string;
}

export interface GemmaSuggestion {
  type: "gemma_suggestion";
  requestId: string;
  sectionIndex: number;
  highlights: SuggestionHighlight[];
}

export interface GemmaUnavailable {
  type: "gemma_unavailable";
}

export type Mode = "auto_send" | "ask_permission";

export interface Snapshot {
  type: "snapshot";
  mode: Mode;
  paused: boolean;
  gemmaAvailable: boolean;
  pendingRequest: NewRequest | null;
  // All requests currently held for approval, oldest first. `pendingRequest`
  // above is the head of this list (kept for back-compat).
  pendingRequests?: NewRequest[];
  latestRequest: NewRequest | null;
  recentRequests?: NewRequest[];
}

export interface TimeoutWarning {
  type: "timeout_warning";
  requestId: string;
}

export type InboundMessage =
  | NewRequest
  | GemmaFlags
  | GemmaSuggestion
  | GemmaUnavailable
  | Snapshot
  | TimeoutWarning;

export interface ApproveRequest {
  type: "approve";
  requestId: string;
}

export interface EditedSection {
  index: number;
  newContent: string;
}

export interface ModifiedRequest {
  type: "approve_modified";
  requestId: string;
  removedIndices: number[];
  editedSections: EditedSection[];
}

export interface ModeChange {
  type: "mode_change";
  mode: Mode;
}

export interface PauseToggle {
  type: "pause_toggle";
  paused: boolean;
}

export interface RequestSuggestion {
  type: "request_suggestion";
  requestId: string;
  sectionIndex: number;
}

export interface ResetCanonical {
  type: "reset_canonical";
}

export type OutboundMessage =
  | ApproveRequest
  | ModifiedRequest
  | ModeChange
  | PauseToggle
  | RequestSuggestion
  | ResetCanonical;

export interface PersistedState {
  gemmaUnavailableNoticeShown: boolean;
}
