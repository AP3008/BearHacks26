import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import "./App.css";
import { BarChart } from "./components/BarChart";
import { EditorPanel } from "./components/EditorPanel";
import { StatusBar } from "./components/StatusBar";
import { SystemHeader } from "./components/SystemHeader";
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
} from "./types";
import { getVsCodeApi } from "./vscode-api";

interface CurrentRequest {
  requestId: string;
  model: string;
  systemSection: Section | null;
  sections: Section[];
  totalTokens: number;
  totalCost: number;
  held: boolean;
}

interface AppState {
  mode: Mode;
  paused: boolean;
  currentRequest: CurrentRequest | null;
  gemmaFlagsByIndex: Record<number, GemmaFlag>;
  removedIndices: Set<number>;
  editedSections: Map<number, string>;
  editorOpenForIndex: number | null;
  gemmaUnavailableNoticeShown: boolean;
}

type Action =
  | { type: "new_request"; msg: NewRequest }
  | { type: "gemma_flags"; msg: GemmaFlags }
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

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "new_request": {
      const { msg } = action;
      const systemSection =
        msg.sections.find((s) => s.sectionType === "system") ?? null;
      const sections = msg.sections.filter((s) => s.sectionType !== "system");
      return {
        ...state,
        currentRequest: {
          requestId: msg.requestId,
          model: msg.model,
          systemSection,
          sections,
          totalTokens: msg.totalTokens,
          totalCost: msg.totalCost,
          held: msg.held ?? state.mode === "ask_permission",
        },
        gemmaFlagsByIndex: {},
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
      return { ...state, gemmaFlagsByIndex: next };
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
      return { ...state, editedSections: next };
    }
    case "open_editor":
      return { ...state, editorOpenForIndex: action.index };
    case "close_editor":
      return { ...state, editorOpenForIndex: null };
    case "after_send": {
      const cr = state.currentRequest;
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
    gemmaFlagsByIndex: {},
    removedIndices: new Set(),
    editedSections: new Map(),
    editorOpenForIndex: null,
    gemmaUnavailableNoticeShown: persisted?.gemmaUnavailableNoticeShown ?? false,
  };
}

const GEMMA_TIMEOUT_MS = 30_000;

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
      dispatch({ type: "new_request", msg });
      // Per-request UI state lives outside the reducer in selection / undo;
      // both must reset whenever a fresh request arrives (NFR-3.3).
      selection.clearAll();
      undo.clear();
    },
    onGemmaFlags: (msg: GemmaFlags) => dispatch({ type: "gemma_flags", msg }),
    onGemmaUnavailable: () => dispatch({ type: "gemma_unavailable" }),
  });

  // Mock harness — only active when ?mock=1 is in the URL.
  useEffect(() => {
    if (!isMockMode()) return;
    return installMockHarness();
  }, []);

  // 30s Gemma fallback: if no flags arrive after a fresh request, show the
  // install notice once (§7.7). Cleared on next new_request.
  useEffect(() => {
    if (!state.currentRequest) return;
    if (state.gemmaUnavailableNoticeShown) return;
    if (Object.keys(state.gemmaFlagsByIndex).length > 0) return;
    const requestId = state.currentRequest.requestId;
    const timer = setTimeout(() => {
      const cur = stateRef.current;
      if (
        cur.currentRequest?.requestId === requestId &&
        Object.keys(cur.gemmaFlagsByIndex).length === 0 &&
        !cur.gemmaUnavailableNoticeShown
      ) {
        dispatch({ type: "mark_gemma_notice_seen" });
      }
    }, GEMMA_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state.currentRequest, state.gemmaFlagsByIndex, state.gemmaUnavailableNoticeShown]);

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
  // request or leave only the lone original user message.
  const canDelete = useCallback(
    (toDelete: Iterable<number>) => {
      const cr = state.currentRequest;
      if (!cr) return false;
      const removed = new Set(state.removedIndices);
      for (const i of toDelete) removed.add(i);
      const remaining = cr.sections.filter((s) => !removed.has(s.index));
      if (remaining.length === 0) return false;
      // If only the very first user message remains (per §7.3), we let the
      // user delete other things but never that one.
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

  const onEditSection = useCallback((index: number, content: string) => {
    dispatch({ type: "edit_section", index, content });
  }, []);

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
    if (cr.systemSection?.index === state.editorOpenForIndex) {
      return cr.systemSection;
    }
    return cr.sections.find((s) => s.index === state.editorOpenForIndex) ?? null;
  }, [state.currentRequest, state.editorOpenForIndex]);

  const editorContent = useMemo(() => {
    if (!editorSection) return "";
    return state.editedSections.get(editorSection.index) ?? editorSection.rawContent;
  }, [editorSection, state.editedSections]);

  const totalTokens = useMemo(() => {
    const cr = state.currentRequest;
    if (!cr) return 0;
    let total = cr.systemSection?.tokenCount ?? 0;
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
      <header className="app-header">
        <SystemHeader
          section={cr.systemSection}
          onOpen={(index) => dispatch({ type: "open_editor", index })}
        />
      </header>

      <main className="app-main">
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key={cr.requestId}
            style={{ position: "absolute", inset: 0, display: "flex" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <BarChart
              sections={visibleSections}
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
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {editorSection && (
            <EditorPanel
              key={editorSection.index}
              section={editorSection}
              content={editorContent}
              gemmaFlag={state.gemmaFlagsByIndex[editorSection.index]}
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
        totalTokens={totalTokens}
        totalCost={totalCost}
        hasEdits={hasEstimate}
        canUndo={undo.size() > 0}
        gemmaUnavailable={
          state.gemmaUnavailableNoticeShown &&
          Object.keys(state.gemmaFlagsByIndex).length === 0
        }
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
      />
    </div>
  );
}
