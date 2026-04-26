import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type * as monacoNs from "monaco-editor";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { GemmaFlag, Section } from "../types";
import "./EditorPanel.css";

interface Props {
  section: Section;
  content: string;
  gemmaFlag: GemmaFlag | undefined;
  flaggingPending: boolean;
  gemmaAvailable: boolean;
  onRequestFlagging: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

interface DecoratedHighlight {
  start: number;
  end: number;
  reason: string;
}

const isWs = (ch: string) => /\s/u.test(ch);

/**
 * Expands a half-open [start, end) span to whitespace delimiters. Mid-word
 * ranges grow to the full word. Whitespace-only ranges grow to a contiguous
 * space run (no adjacent words are absorbed).
 */
function expandHighlightToWhitespaceBoundaries(
  content: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const n = content.length;
  if (n === 0) {
    return { start: 0, end: 0 };
  }
  let s = Math.max(0, Math.min(start, n));
  let e = Math.max(0, Math.min(end, n));
  if (e < s) {
    const t = s;
    s = e;
    e = t;
  }

  if (e > s) {
    let sMin = s;
    while (sMin < e && sMin < n && isWs(content[sMin]!)) sMin++;
    if (sMin >= e) {
      let a = s;
      while (a > 0 && isWs(content[a - 1]!)) a--;
      let b = e;
      while (b < n && isWs(content[b]!)) b++;
      return { start: a, end: b };
    }
    let sMax = e - 1;
    while (sMax >= s && sMax >= 0 && isWs(content[sMax]!)) sMax--;
    s = sMin;
    while (s > 0 && !isWs(content[s - 1]!)) s--;
    e = sMax + 1;
    while (e < n && !isWs(content[e]!)) e++;
    return { start: s, end: e };
  }

  if (s >= n) {
    return { start: n, end: n };
  }
  if (isWs(content[s]!)) {
    let a = s;
    while (a > 0 && isWs(content[a - 1]!)) a--;
    let b = s;
    while (b < n && isWs(content[b]!)) b++;
    return { start: a, end: b };
  }
  let left = s;
  while (left > 0 && !isWs(content[left - 1]!)) left--;
  let right = s;
  while (right < n && !isWs(content[right]!)) right++;
  return { start: left, end: right };
}

function isWhitespaceOnlyGap(content: string, gapStart: number, gapEnd: number): boolean {
  const n = content.length;
  for (let i = Math.max(0, gapStart); i < Math.min(gapEnd, n); i++) {
    if (!isWs(content[i]!)) return false;
  }
  return true;
}

/**
 * Merges overlapping/touching ranges, and ranges separated only by whitespace
 * (e.g. [0,44) and [45,103) where index 44 is a space) so the gap is not
 * unstyled between consecutive Gemma word spans.
 */
function mergeDecoratedHighlights(
  content: string,
  items: readonly DecoratedHighlight[],
): DecoratedHighlight[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: DecoratedHighlight[] = [];
  let cur: DecoratedHighlight = { ...sorted[0]! };
  for (let i = 1; i < sorted.length; i++) {
    const h = sorted[i]!;
    const gapStart = cur.end;
    const gapEnd = h.start;
    const shouldMerge =
      h.start <= cur.end || isWhitespaceOnlyGap(content, gapStart, gapEnd);
    if (shouldMerge) {
      cur = {
        start: cur.start,
        end: Math.max(cur.end, h.end),
        reason: cur.reason || h.reason,
      };
    } else {
      out.push(cur);
      cur = { ...h };
    }
  }
  out.push(cur);
  return out;
}

const TYPE_LABEL: Record<string, string> = {
  system: "System prompt",
  tool_def: "Tool definition",
  user: "User message",
  assistant: "Assistant response",
  tool_call: "Tool call",
  tool_output: "Tool output",
  image: "Image content",
  thinking: "Thinking",
  unknown: "Unknown section",
};

// Section types whose Monaco view is structural (Anthropic schema-bound),
// not free-form text. Edits to these don't round-trip back into the upstream
// body — see backend gating._apply_block_edit. The user can still delete
// the section to skip it. Without this, a user editing the rendered text of
// e.g. a tool_use block would silently see their changes dropped.
const STRUCTURED_TYPES = new Set(["tool_def", "tool_call", "image", "thinking"]);

function languageFor(section: Section): string {
  // Tool calls are structured JSON. Tool outputs can be logs, source code, or
  // plain text, so avoid Monaco's JSON diagnostics unless the content is JSON.
  if (section.sectionType === "tool_call") {
    return "json";
  }
  if (section.sectionType === "tool_output") {
    return detectToolOutputLanguage(section.rawContent);
  }
  return "markdown";
}

function detectToolOutputLanguage(rawContent: string): string {
  const text = rawContent.trim();
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const lowerFirstLine = firstLine.toLowerCase();

  const pathMatch =
    firstLine.match(/(?:^|\s)([\w./@-]+\.(tsx|ts|jsx|js|py|css|scss|html|json|md|ya?ml|toml|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|rb|sh|bash|zsh|sql))(?::\d+)?(?:\s|$)/i) ??
    text.match(/(?:^|\s)([\w./@-]+\.(tsx|ts|jsx|js|py|css|scss|html|json|md|ya?ml|toml|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|rb|sh|bash|zsh|sql))(?::\d+)?(?:\s|$)/i);

  const ext = pathMatch?.[2]?.toLowerCase();
  if (ext) {
    const byExtension: Record<string, string> = {
      tsx: "typescript",
      ts: "typescript",
      jsx: "javascript",
      js: "javascript",
      py: "python",
      css: "css",
      scss: "scss",
      html: "html",
      json: "json",
      md: "markdown",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      rs: "rust",
      go: "go",
      java: "java",
      kt: "kotlin",
      swift: "swift",
      c: "c",
      h: "c",
      cpp: "cpp",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      rb: "ruby",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      sql: "sql",
    };
    return byExtension[ext] ?? "plaintext";
  }

  if (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    return "json";
  }
  if (text.startsWith("<!doctype html") || /<\/?[a-z][\s\S]*>/i.test(text.slice(0, 500))) {
    return "html";
  }
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(text) || /\b(?:npm|pnpm|yarn|git|cd|mkdir|rm|cp|mv)\s+/.test(text)) {
    return "shell";
  }
  if (/\bfrom\s+["'][^"']+["']\s+import\b|\bimport\s+type\b|\binterface\s+\w+|\btype\s+\w+\s*=|\bconst\s+\w+\s*[:=]/.test(text)) {
    return "typescript";
  }
  if (/\bimport\s+\w+|\bdef\s+\w+\(|\bclass\s+\w+[:(]/.test(text) && /:\s*(?:\n|#)/.test(text)) {
    return "python";
  }
  if (/[.#]?[a-z0-9_-]+\s*\{[\s\S]*:\s*[^;]+;/.test(text)) {
    return "css";
  }
  if (lowerFirstLine.includes("diff --git") || /^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(text)) {
    return "diff";
  }

  return "plaintext";
}

function defineTheme(monaco: Monaco) {
  const root = getComputedStyle(document.documentElement);
  const v = (k: string, fallback: string) => (root.getPropertyValue(k).trim() || fallback);
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: false,
    allowComments: true,
    trailingCommas: "ignore",
  });
  monaco.languages.css.cssDefaults.setOptions({ validate: false });
  monaco.languages.css.scssDefaults.setOptions({ validate: false });
  monaco.languages.html.htmlDefaults.setOptions({ validate: false });
  monaco.editor.defineTheme("autonomy", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": v("--cl-bg", "#11100f"),
      "editor.foreground": v("--cl-text", "#f3e7dc"),
      "editorLineNumber.foreground": v("--cl-muted", "#aa9a8a"),
      "editor.selectionBackground": v(
        "--cl-accent-soft",
        "rgba(217, 119, 58, 0.16)",
      ),
      "editorCursor.foreground": v("--cl-accent-strong", "#f28c45"),
    },
  });
}

export function EditorPanel({
  section,
  content,
  gemmaFlag,
  flaggingPending,
  gemmaAvailable,
  onRequestFlagging,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const language = useMemo(() => languageFor(section), [section]);
  const tokenEstimate = useMemo(
    () => Math.max(1, Math.ceil(content.length / 4)),
    [content],
  );

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      defineTheme(monaco);
      monaco.editor.setTheme("autonomy");
      // Double-click-to-accept on a Gemma decoration: detect a click inside any
      // decoration range and splice that range out.
      editor.onMouseDown((e) => {
        const clickCount =
          // Monaco forwards browser click count as `detail` (sometimes nested).
          (e.event as unknown as { detail?: number; browserEvent?: { detail?: number } })
            .detail ?? (e.event as unknown as { browserEvent?: { detail?: number } }).browserEvent?.detail;
        if (clickCount !== 2) return;
        const target = e.target;
        const pos = target.position;
        if (!pos) return;
        const model = editor.getModel();
        if (!model) return;
        const decos = model.getAllDecorations();
        for (const d of decos) {
          if (d.options.className !== "gemma-highlight") continue;
          if (!d.range.containsPosition(pos)) continue;
          editor.executeEdits("gemma-accept", [
            {
              range: d.range,
              text: "",
              forceMoveMarkers: true,
            },
          ]);
          return;
        }
      });
    },
    [],
  );

  const resolvedHighlights = useMemo<DecoratedHighlight[]>(() => {
    if (gemmaFlag && gemmaFlag.highlights.length > 0) {
      return gemmaFlag.highlights.map((h) => ({
        start: h.start,
        end: h.end,
        reason: gemmaFlag.reason,
      }));
    }
    return [];
  }, [gemmaFlag]);

  const expandedHighlights = useMemo(() => {
    if (resolvedHighlights.length === 0) return [];
    const expanded = resolvedHighlights.map((h) => {
      const { start, end } = expandHighlightToWhitespaceBoundaries(
        content,
        h.start,
        h.end,
      );
      return { ...h, start, end };
    }).filter((h) => h.start < h.end);
    return mergeDecoratedHighlights(content, expanded);
  }, [resolvedHighlights, content]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model || expandedHighlights.length === 0) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const newDecorations: monacoNs.editor.IModelDeltaDecoration[] = expandedHighlights.map((h) => {
      const start = Math.max(0, Math.min(h.start, content.length));
      const end = Math.max(start, Math.min(h.end, content.length));
      const startPos = model.getPositionAt(start);
      const endPos = model.getPositionAt(end);
      return {
        range: new monaco.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
        options: {
          className: "gemma-highlight",
          inlineClassName: "gemma-highlight-inline",
          hoverMessage: { value: h.reason },
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    });
    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      newDecorations,
    );
  }, [resolvedHighlights, content]);

  // Live-edit: every Monaco change (typing, paste, click-to-accept Gemma
  // highlight via executeEdits) commits straight to parent state. Previously
  // we kept a local `draftContent` and only committed on Save click — closing
  // the panel, switching sections, or clicking Send silently dropped edits,
  // which violated the product's "what's in the editor is what gets sent"
  // promise.
  const onEditorChange = useCallback(
    (value: string | undefined) => {
      onSave(value ?? "");
    },
    [onSave],
  );

  return (
    <motion.aside
      className="editor-panel"
      aria-label="Section editor"
      initial={{ x: "6%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "6%", opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
    >
      <header className="editor-head">
        <div className="editor-head-left">
          <span className={`type-badge type-${section.sectionType}`}>
            {TYPE_LABEL[section.sectionType] ?? section.sectionType}
          </span>
          <span className="muted">
            <strong>{tokenEstimate.toLocaleString()}</strong> tokens{" "}
            <span className="estimate">(estimate)</span>
          </span>
        </div>
        <div className="editor-head-right">
          {STRUCTURED_TYPES.has(section.sectionType) && (
            <span
              className="muted"
              title="This section is a structured Anthropic block (tool definition, tool call, or image). Free-form text edits can't round-trip back into its schema, so the editor is read-only. Delete the section to skip it for this request."
            >
              structured · delete to skip
            </span>
          )}
          <button
            className="btn"
            type="button"
            onClick={onRequestFlagging}
            disabled={
              !gemmaAvailable ||
              flaggingPending ||
              ((gemmaFlag?.highlights?.length ?? 0) > 0)
            }
            title={
              !gemmaAvailable
                ? "Gemma offline"
                : gemmaFlag
                  ? (gemmaFlag.highlights.length > 0
                      ? "Already flagged for this section"
                      : "Analyze again")
                  : flaggingPending
                    ? "Analyzing…"
                    : "Run flagging on this request"
            }
          >
            Flag context
          </button>
          <button className="btn danger" onClick={onDelete} type="button">
            Delete section
          </button>
          <button className="btn" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </header>
      <div className="editor-body">
        <div className="editor-split">
          <div className="editor-main">
            <Editor
              height="100%"
              language={language}
              value={content}
              onMount={handleMount}
              onChange={onEditorChange}
              theme="autonomy"
              options={{
                minimap: { enabled: false },
                wordWrap: "on",
                scrollBeyondLastLine: false,
                fontSize: 13,
                renderWhitespace: "selection",
                scrollbar: {
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10,
                },
                lineHeight: 19,
                readOnly: STRUCTURED_TYPES.has(section.sectionType),
              }}
            />
          </div>
        </div>
        {gemmaAvailable && flaggingPending && (
          <div className="gemma-spinner" aria-hidden="true">
            <span className="spinner-dot" />
            <span>Gemma analyzing…</span>
          </div>
        )}
        {!gemmaAvailable && (
          <div className="gemma-status gemma-status-offline" aria-hidden="true">
            <span>Gemma offline — no flagging.</span>
          </div>
        )}
      </div>
    </motion.aside>
  );
}
