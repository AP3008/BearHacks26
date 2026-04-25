import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import "./App.css";
import { BarChart } from "./components/BarChart";
import { EditorPanel } from "./components/EditorPanel";
import { StatusBar } from "./components/StatusBar";
import { useSelection } from "./hooks/useSelection";
import { useUndo, type UndoSnapshot } from "./hooks/useUndo";
import { useWebSocket } from "./hooks/useWebSocket";
import { installMockHarness, isMockMode } from "./mock/harness";
import type {
  EditedSection,
  GemmaFlag,
  GemmaFlags,
  Mode,
  NewRequest,
  Section,
  Snapshot,
} from "./types";
import { getVsCodeApi } from "./vscode-api";

interface CurrentRequest {
  requestId: string;
  model: string;
  sections: Section[];
  totalTokens: number;
  totalCost: number;
  held: boolean;
}

interface AppState {
  mode: Mode;
  paused: boolean;
  currentRequest: CurrentRequest | null;
  // Held requests that arrived while another was already pending. The proxy
  // only ever holds one at a time in normal use, but this guards against
  // back-to-back rapid prompts silently displacing one another.
  pendingQueue: NewRequest[];
  gemmaFlagsByIndex: Record<number, GemmaFlag>;
  isFlaggingPending: boolean;
  removedIndices: Set<number>;
  editedSections: Map<number, string>;
  editorOpenForIndex: number | null;
  gemmaAvailable: boolean;
  gemmaUnavailableNoticeShown: boolean;
}

type Action =
  | { type: "new_request"; msg: NewRequest }
  | { type: "snapshot"; msg: Snapshot }
  | { type: "gemma_flags"; msg: GemmaFlags }
  | { type: "request_flagging_pending" }
  | { type: "gemma_unavailable" }
  | { type: "mode_change"; mode: Mode }
  | { type: "pause_toggle"; paused: boolean }
  | { type: "confirm_removed"; indices: number[] }
  | { type: "apply_snapshot"; snapshot: UndoSnapshot }
  | { type: "edit_section"; index: number; content: string }
  | { type: "open_editor"; index: number }
  | { type: "close_editor" }
  | { type: "after_send" }
  | { type: "mark_gemma_notice_seen" };

function buildCurrentRequest(msg: NewRequest, fallbackHeld: boolean): CurrentRequest {
  return {
    requestId: msg.requestId,
    model: msg.model,
    sections: msg.sections,
    totalTokens: msg.totalTokens,
    totalCost: msg.totalCost,
    held: msg.held ?? fallbackHeld,
  };
}

// Distinguish "main conversation" requests from Claude Code's auxiliary
// calls (title generation, topic detection, conversation summary). Aux
// calls have a tiny system prompt and ship no `tools`, while every main
// request defines the full tool set. Without this filter, those tiny aux
// requests overwrite the main-chat chart on every keystroke.
function isMainConversationRequest(msg: NewRequest): boolean {
  return msg.sections.some((s) => s.sectionType === "tool_def");
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "snapshot": {
      const { msg } = action;
      const incoming = msg.pendingRequest ?? msg.latestRequest ?? null;
      const isHeld = msg.pendingRequest !== null;
      const next: AppState = {
        ...state,
        mode: msg.mode,
        paused: msg.paused,
        gemmaAvailable: msg.gemmaAvailable,
      };
      // Reconcile multi-hold queue: server is source of truth. Filter to
      // main-conversation, drop the head (which becomes currentRequest),
      // and replace local pendingQueue. Without this, reconnecting after
      // multiple holds piled up shows only one — the rest stay invisible.
      const pendingFromSnapshot = (msg.pendingRequests ?? []).filter(
        isMainConversationRequest,
      );
      if (pendingFromSnapshot.length > 1) {
        next.pendingQueue = pendingFromSnapshot.slice(1);
      } else if (state.pendingQueue.length > 0 && pendingFromSnapshot.length <= 1) {
        // Server has cleared queue (e.g. all queued requests were resolved
        // while the panel was disconnected). Sync down.
        next.pendingQueue = [];
      }
      if (incoming && isMainConversationRequest(incoming)) {
        const sameId = state.currentRequest?.requestId === incoming.requestId;
        if (!sameId) {
          // tool_chain steps within a top-level turn must preserve the
          // user's in-flight edits — backend canonical already reflects
          // committed deletes, but a section the user *was* editing in
          // Monaco should keep its uncommitted text. Only top_level boundaries
          // signal "new turn, start clean."
          const isTopLevel = (incoming.kind ?? "top_level") === "top_level";
          next.currentRequest = buildCurrentRequest(incoming, isHeld);
          if (isTopLevel) {
            next.gemmaFlagsByIndex = {};
            next.isFlaggingPending = false;
            next.removedIndices = new Set();
            next.editedSections = new Map();
            next.editorOpenForIndex = null;
          }
        } else if (state.currentRequest && state.currentRequest.held !== isHeld) {
          next.currentRequest = { ...state.currentRequest, held: isHeld };
        }
      }
      return next;
    }
    case "new_request": {
      const { msg } = action;
      // Skip auxiliary Claude Code calls (title gen, topic detection,
      // summarization). They have no tools and tiny system prompts; if we
      // let them through they overwrite the main chart with 2-3 bars of
      // noise. The main conversation chart stays put across them.
      if (!isMainConversationRequest(msg)) {
        return state;
      }
      // If a different request is currently held, queue the new arrival
      // instead of silently displacing it (which would leave the proxy
      // waiting on an event nobody can fire).
      if (
        state.currentRequest &&
        state.currentRequest.held &&
        state.currentRequest.requestId !== msg.requestId
      ) {
        return { ...state, pendingQueue: [...state.pendingQueue, msg] };
      }
      const isHeld = msg.held ?? state.mode === "ask_permission";
      const isTopLevel = (msg.kind ?? "top_level") === "top_level";
      // tool_chain continuations preserve in-flight edits / Gemma flags so a
      // section the user was mid-editing in Monaco doesn't lose its text the
      // moment the next step arrives. top_level prompts always start clean.
      if (!isTopLevel) {
        return {
          ...state,
          currentRequest: buildCurrentRequest(msg, isHeld),
        };
      }
      return {
        ...state,
        currentRequest: buildCurrentRequest(msg, isHeld),
        gemmaFlagsByIndex: {},
        isFlaggingPending: false,
        removedIndices: new Set(),
        editedSections: new Map(),
        editorOpenForIndex: null,
      };
    }
    case "gemma_flags": {
      if (
        !state.currentRequest ||
        state.currentRequest.requestId !== action.msg.requestId
      ) {
        return state;
      }
      const next = { ...state.gemmaFlagsByIndex };
      for (const flag of action.msg.flags) next[flag.sectionIndex] = flag;
      return { ...state, gemmaFlagsByIndex: next, isFlaggingPending: false };
    }
    case "request_flagging_pending": {
      if (state.isFlaggingPending) return state;
      return { ...state, isFlaggingPending: true };
    }
    case "gemma_unavailable":
      return { ...state, gemmaUnavailableNoticeShown: true };
    case "mode_change":
      return { ...state, mode: action.mode };
    case "pause_toggle":
      return { ...state, paused: action.paused };
    case "confirm_removed": {
      const next = new Set(state.removedIndices);
      for (const i of action.indices) next.add(i);
      return { ...state, removedIndices: next };
    }
    case "apply_snapshot":
      return {
        ...state,
        removedIndices: new Set(action.snapshot.removedIndices),
        editedSections: new Map(action.snapshot.editedSections),
      };
    case "edit_section": {
      const next = new Map(state.editedSections);
      next.set(action.index, action.content);
      // Drop the stale Gemma flag for this section — its highlights point
      // at character offsets in the old `rawContent` and would visually
      // misalign on the edited text.
      const nextFlags = { ...state.gemmaFlagsByIndex };
      delete nextFlags[action.index];
      return { ...state, editedSections: next, gemmaFlagsByIndex: nextFlags };
    }
    case "open_editor":
      return { ...state, editorOpenForIndex: action.index };
    case "close_editor":
      return { ...state, editorOpenForIndex: null };
    case "after_send": {
      const cr = state.currentRequest;
      // Promote next queued held request (if any) so the user can keep going.
      if (state.pendingQueue.length > 0) {
        const [next, ...rest] = state.pendingQueue;
        const isHeld = next.held ?? state.mode === "ask_permission";
        return {
          ...state,
          currentRequest: buildCurrentRequest(next, isHeld),
          pendingQueue: rest,
          gemmaFlagsByIndex: {},
          isFlaggingPending: false,
          removedIndices: new Set(),
          editedSections: new Map(),
          editorOpenForIndex: null,
        };
      }
      return {
        ...state,
        currentRequest: cr ? { ...cr, held: false } : null,
        removedIndices: new Set(),
        editedSections: new Map(),
        editorOpenForIndex: null,
      };
    }
    case "mark_gemma_notice_seen":
      return { ...state, gemmaUnavailableNoticeShown: true };
  }
}

function loadInitialState(): AppState {
  const persisted = getVsCodeApi().getState();
  return {
    mode: "auto_send",
    paused: false,
    currentRequest: null,
    pendingQueue: [],
    gemmaFlagsByIndex: {},
    isFlaggingPending: false,
    removedIndices: new Set(),
    editedSections: new Map(),
    editorOpenForIndex: null,
    // Optimistic until the proxy snapshot tells us otherwise — the snapshot
    // arrives within a tick of WS connect.
    gemmaAvailable: true,
    gemmaUnavailableNoticeShown: persisted?.gemmaUnavailableNoticeShown ?? false,
  };
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitialState);
  const selection = useSelection();
  const undo = useUndo({
    applySnapshot: useCallback(
      (snapshot) => dispatch({ type: "apply_snapshot", snapshot }),
      [],
    ),
  });

  // Persist the one-time Gemma-unavailable notice flag so reload doesn't
  // re-show it (instructions §7.7 / FR-8.8).
  useEffect(() => {
    getVsCodeApi().setState({
      gemmaUnavailableNoticeShown: state.gemmaUnavailableNoticeShown,
    });
  }, [state.gemmaUnavailableNoticeShown]);

  // Latest-state mirror so the 30s Gemma timeout can re-check at fire time.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const senders = useWebSocket({
    onNewRequest: (msg: NewRequest) => {
      // Auxiliary calls (no tools) get filtered inside the reducer; only
      // clear marks/undo when the chart is actually about to change AND
      // we're crossing a top_level boundary. Within a top_level turn,
      // tool_chain steps keep the undo stack so Cmd+Z still reverts edits
      // made earlier in the turn.
      const cur = stateRef.current;
      const isMain = msg.sections.some((s) => s.sectionType === "tool_def");
      const isTopLevel = (msg.kind ?? "top_level") === "top_level";
      const willReplace =
        isMain &&
        !(
          cur.currentRequest &&
          cur.currentRequest.held &&
          cur.currentRequest.requestId !== msg.requestId
        ) &&
        (!cur.currentRequest || cur.currentRequest.requestId !== msg.requestId);
      dispatch({ type: "new_request", msg });
      if (willReplace && isTopLevel) {
        selection.clearAll();
        undo.clear();
      }
    },
    onGemmaFlags: (msg: GemmaFlags) => dispatch({ type: "gemma_flags", msg }),
    onGemmaUnavailable: () => dispatch({ type: "gemma_unavailable" }),
    onSnapshot: (msg: Snapshot) => {
      const cur = stateRef.current;
      const incoming = msg.pendingRequest ?? msg.latestRequest ?? null;
      const isMain =
        !!incoming && incoming.sections.some((s) => s.sectionType === "tool_def");
      const isTopLevel = (incoming?.kind ?? "top_level") === "top_level";
      const replacingRequest =
        isMain &&
        (!cur.currentRequest || cur.currentRequest.requestId !== incoming!.requestId);
      dispatch({ type: "snapshot", msg });
      if (replacingRequest && isTopLevel) {
        selection.clearAll();
        undo.clear();
      }
    },
  });

  // Mock harness — only active when ?mock=1 is in the URL.
  useEffect(() => {
    if (!isMockMode()) return;
    return installMockHarness();
  }, []);

  // Visible-section computation: source list minus removed indices, with edits
  // overlaid for live token estimation.
  const visibleSections = useMemo<Section[]>(() => {
    const cr = state.currentRequest;
    if (!cr) return [];
    return cr.sections
      .filter((s) => !state.removedIndices.has(s.index))
      .map((s) => {
        const edited = state.editedSections.get(s.index);
        if (edited == null) return s;
        const tokenCount = Math.max(1, Math.ceil(edited.length / 4));
        return { ...s, rawContent: edited, tokenCount };
      });
  }, [state.currentRequest, state.removedIndices, state.editedSections]);

  // Empty-conversation guard (§7.3): block deletion that would empty the
  // request or leave only the lone original user message. Also block
  // deletes that would leave a `tool_result` user message (sectionType
  // "tool_output") with no preceding `tool_use` assistant message — that's
  // a 400 from Anthropic ("orphan tool_result"), so we must catch it
  // *before* the user commits the delete to canonical, where it would
  // poison every future request until they hit Reset edits.
  const canDelete = useCallback(
    (toDelete: Iterable<number>) => {
      const cr = state.currentRequest;
      if (!cr) return false;
      const removed = new Set(state.removedIndices);
      for (const i of toDelete) removed.add(i);
      const remaining = cr.sections.filter((s) => !removed.has(s.index));
      if (remaining.length === 0) return false;
      // Orphan check: walk remaining in order, ensure cumulative tool_call
      // count never falls below cumulative tool_output count. (Approximate —
      // we can't match by tool_use_id since rawContent doesn't carry it
      // structured — but conservatively correct.)
      let calls = 0;
      let outputs = 0;
      for (const s of remaining) {
        if (s.sectionType === "tool_call") calls += 1;
        if (s.sectionType === "tool_output") {
          outputs += 1;
          if (outputs > calls) return false;
        }
      }
      return true;
    },
    [state.currentRequest, state.removedIndices],
  );

  // Intercept marking + confirming so the empty-conversation guard runs there.
  const confirmDeletion = useCallback(() => {
    const cr = state.currentRequest;
    if (!cr) return;
    const indices = [...selection.markedForDelete];
    if (indices.length === 0) return;
    if (!canDelete(indices)) {
      selection.clearMarks();
      return;
    }
    undo.push({
      removedIndices: state.removedIndices,
      editedSections: state.editedSections,
    });
    dispatch({ type: "confirm_removed", indices });
    selection.clearAll();
  }, [
    state.currentRequest,
    state.removedIndices,
    state.editedSections,
    selection,
    canDelete,
    undo,
  ]);

  const tryMarkSelected = useCallback(() => {
    const cr = state.currentRequest;
    if (!cr) return;
    if (selection.selectedIndices.size === 0) return;
    // Don't allow marking if confirming the result would empty things.
    const wouldDelete = new Set([
      ...state.removedIndices,
      ...selection.selectedIndices,
    ]);
    const remaining = cr.sections.filter((s) => !wouldDelete.has(s.index));
    if (remaining.length === 0) return;
    selection.markSelectedForDelete();
  }, [state.currentRequest, state.removedIndices, selection]);

  const handleUndo = useCallback(() => {
    if (undo.size() === 0) return;
    undo.undo();
    selection.clearAll();
  }, [undo, selection]);

  // App-level keybindings — only when the editor panel is closed so Monaco
  // owns its keys (instructions §10).
  useEffect(() => {
    if (state.editorOpenForIndex !== null) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        tryMarkSelected();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirmDeletion();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handleUndo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.editorOpenForIndex, tryMarkSelected, confirmDeletion, handleUndo]);

  const onSend = useCallback(() => {
    const cr = state.currentRequest;
    if (!cr) return;
    if (state.removedIndices.size === 0 && state.editedSections.size === 0) {
      senders.sendApprove(cr.requestId);
    } else {
      const editedSections: EditedSection[] = [...state.editedSections].map(
        ([index, newContent]) => ({ index, newContent }),
      );
      senders.sendApproveModified(
        cr.requestId,
        [...state.removedIndices],
        editedSections,
      );
    }
    undo.clear();
    selection.clearAll();
    dispatch({ type: "after_send" });
  }, [state.currentRequest, state.removedIndices, state.editedSections, senders, undo, selection]);

  const onEditSection = useCallback(
    (index: number, content: string) => {
      dispatch({ type: "edit_section", index, content });
    },
    [],
  );

  const onDeleteFromEditor = useCallback(
    (index: number) => {
      if (!canDelete([index])) return;
      undo.push({
        removedIndices: state.removedIndices,
        editedSections: state.editedSections,
      });
      dispatch({ type: "confirm_removed", indices: [index] });
      dispatch({ type: "close_editor" });
      selection.clearAll();
    },
    [state.removedIndices, state.editedSections, canDelete, undo, selection],
  );

  const editorSection = useMemo<Section | null>(() => {
    const cr = state.currentRequest;
    if (!cr || state.editorOpenForIndex == null) return null;
    return cr.sections.find((s) => s.index === state.editorOpenForIndex) ?? null;
  }, [state.currentRequest, state.editorOpenForIndex]);

  const editorContent = useMemo(() => {
    if (!editorSection) return "";
    return state.editedSections.get(editorSection.index) ?? editorSection.rawContent;
  }, [editorSection, state.editedSections]);

  const requestFlagging = useCallback(() => {
    const cr = state.currentRequest;
    if (!cr || !editorSection) return;
    if (!state.gemmaAvailable) return;
    if (state.isFlaggingPending) return;
    dispatch({ type: "request_flagging_pending" });
    senders.sendRequestFlagging(cr.requestId, editorSection.index);
  }, [
    state.currentRequest,
    editorSection,
    state.gemmaAvailable,
    state.isFlaggingPending,
    senders,
  ]);

  const totalTokens = useMemo(() => {
    const cr = state.currentRequest;
    if (!cr) return 0;
    let total = 0;
    for (const s of visibleSections) total += s.tokenCount;
    return total;
  }, [state.currentRequest, visibleSections]);

  const totalCost = useMemo(() => {
    const cr = state.currentRequest;
    if (!cr) return 0;
    if (cr.totalTokens === 0) return cr.totalCost;
    return (totalTokens / cr.totalTokens) * cr.totalCost;
  }, [state.currentRequest, totalTokens]);

  const hasEstimate = state.editedSections.size > 0;

  if (!state.currentRequest) {
    return (
      <div className="app empty">
        <motion.div
          className="empty-card"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 28 }}
        >
          <h1>ContextLens</h1>
          <p>Waiting for the next Claude Code API call…</p>
          <p className="hint">
            Run Claude Code with{" "}
            <code>ANTHROPIC_BASE_URL=http://localhost:8080</code> to start
            streaming context here.
          </p>
        </motion.div>
      </div>
    );
  }

  const cr = state.currentRequest;

  return (
    <div className={`app ${state.editorOpenForIndex !== null ? "with-editor" : ""}`}>
      <main className="app-main">
        {/* Don't key on requestId — Claude Code emits a fresh requestId per
            tool-chain step, so keying here used to cross-fade the entire
            chart 5–10× per turn, making bars look like they were "missing"
            or flashing. The chart now updates in place. */}
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <BarChart
            sections={visibleSections}
            allSections={cr.sections}
            selectedIndices={selection.selectedIndices}
            markedForDelete={selection.markedForDelete}
            gemmaFlagsByIndex={state.gemmaFlagsByIndex}
            onSelect={(index, shift) => {
              if (shift) {
                selection.rangeSelect(
                  index,
                  visibleSections.map((s) => s.index),
                );
              } else {
                selection.select(index);
              }
            }}
            onOpenEditor={(index) => dispatch({ type: "open_editor", index })}
          />
        </div>

        <AnimatePresence>
          {editorSection && (
            <EditorPanel
              key={editorSection.index}
              section={editorSection}
              content={editorContent}
              gemmaFlag={state.gemmaFlagsByIndex[editorSection.index]}
              flaggingPending={state.isFlaggingPending}
              gemmaAvailable={state.gemmaAvailable}
              onRequestFlagging={requestFlagging}
              onSave={(text) => onEditSection(editorSection.index, text)}
              onDelete={() => onDeleteFromEditor(editorSection.index)}
              onClose={() => dispatch({ type: "close_editor" })}
            />
          )}
        </AnimatePresence>
      </main>

      <StatusBar
        mode={state.mode}
        paused={state.paused}
        held={cr.held}
        queueLength={state.pendingQueue.length}
        totalTokens={totalTokens}
        totalCost={totalCost}
        hasEdits={hasEstimate}
        canUndo={undo.size() > 0}
        gemmaUnavailable={!state.gemmaAvailable}
        onModeChange={(mode) => {
          dispatch({ type: "mode_change", mode });
          senders.sendModeChange(mode);
        }}
        onTogglePause={() => {
          const next = !state.paused;
          dispatch({ type: "pause_toggle", paused: next });
          senders.sendPauseToggle(next);
        }}
        onSend={onSend}
        onUndo={handleUndo}
        onResetEdits={() => {
          // Confirmation here, not in StatusBar, so the StatusBar stays a
          // dumb presentational component.
          if (
            window.confirm(
              "Clear all saved edits? Future requests will start from Claude Code's full context again. This cannot be undone.",
            )
          ) {
            senders.sendResetCanonical();
          }
        }}
      />
    </div>
  );
}
