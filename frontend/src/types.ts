// Canonical message contracts shared with the proxy / extension host.
// Keep these byte-for-byte aligned with PRD §9 — do not redefine elsewhere.

export type SectionType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_output"
  | "unknown";

export interface Section {
  index: number;
  sectionType: SectionType;
  tokenCount: number;
  cost: number;
  contentPreview: string;
  rawContent: string;
}

export interface NewRequest {
  type: "new_request";
  requestId: string;
  sections: Section[];
  totalTokens: number;
  totalCost: number;
  model: string;
  held?: boolean;
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

export interface GemmaUnavailable {
  type: "gemma_unavailable";
}

export type InboundMessage = NewRequest | GemmaFlags | GemmaUnavailable;

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

export type Mode = "auto_send" | "ask_permission";

export interface ModeChange {
  type: "mode_change";
  mode: Mode;
}

export interface PauseToggle {
  type: "pause_toggle";
  paused: boolean;
}

export type OutboundMessage =
  | ApproveRequest
  | ModifiedRequest
  | ModeChange
  | PauseToggle;

export interface PersistedState {
  gemmaUnavailableNoticeShown: boolean;
}
