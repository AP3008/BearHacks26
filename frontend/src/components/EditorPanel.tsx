import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type * as monacoNs from "monaco-editor";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { GemmaFlag, GemmaSuggestion, Section } from "../types";
import "./EditorPanel.css";

interface Props {
  section: Section;
  content: string;
  gemmaFlag: GemmaFlag | undefined;
  // Per-section suggestion fired on demand when this editor opens. Carries
  // character-range highlights with their own per-range `reason` strings.
  suggestion: GemmaSuggestion | undefined;
  // True while we're waiting on a suggestion response. Drives the spinner.
  // Without this prop, the spinner used to show whenever no flag existed,
  // which lied to the user about Gemma "still analyzing" forever.
  suggestionPending: boolean;
  gemmaAvailable: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

interface DecoratedHighlight {
  start: number;
  end: number;
  reason: string;
}

const TYPE_LABEL: Record<string, string> = {
  system: "System prompt",
  tool_def: "Tool definition",
  user: "User message",
  assistant: "Assistant response",
  tool_call: "Tool call",
  tool_output: "Tool output",
  image: "Image content",
  unknown: "Unknown section",
};

// Section types whose Monaco view is structural (Anthropic schema-bound),
// not free-form text. Edits to these don't round-trip back into the upstream
// body — see backend gating._apply_block_edit. The user can still delete
// the section to skip it. Without this, a user editing the rendered text of
// e.g. a tool_use block would silently see their changes dropped.
const STRUCTURED_TYPES = new Set(["tool_def", "tool_call", "image"]);

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
  monaco.editor.defineTheme("contextlens", {
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
  suggestion,
  suggestionPending,
  gemmaAvailable,
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
      monaco.editor.setTheme("contextlens");
      // Click-to-accept on a Gemma decoration: detect a click inside any
      // decoration range and splice that range out.
      editor.onMouseDown((e) => {
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

  // Resolved highlight set: prefer the on-demand suggestion (richer, has a
  // reason per range), fall back to whatever the broad-flagging pass found.
  // Either way each highlight carries its own reason string for hover.
  const resolvedHighlights = useMemo<DecoratedHighlight[]>(() => {
    if (suggestion && suggestion.highlights.length > 0) {
      return suggestion.highlights.map((h) => ({
        start: h.start,
        end: h.end,
        reason: h.reason || "Gemma suggests removing this.",
      }));
    }
    if (gemmaFlag && gemmaFlag.highlights.length > 0) {
      return gemmaFlag.highlights.map((h) => ({
        start: h.start,
        end: h.end,
        reason: gemmaFlag.reason,
      }));
    }
    return [];
  }, [suggestion, gemmaFlag]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model || resolvedHighlights.length === 0) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const newDecorations: monacoNs.editor.IModelDeltaDecoration[] = resolvedHighlights.map((h) => {
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
          <button className="btn danger" onClick={onDelete} type="button">
            Delete section
          </button>
          <button className="btn" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </header>
      <div className="editor-body">
        <Editor
          height="100%"
          language={language}
          value={content}
          onMount={handleMount}
          onChange={onEditorChange}
          theme="contextlens"
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
        {gemmaAvailable && suggestionPending && (
          <div className="gemma-spinner" aria-hidden="true">
            <span className="spinner-dot" />
            <span>Gemma analyzing…</span>
          </div>
        )}
        {gemmaAvailable &&
          !suggestionPending &&
          suggestion &&
          suggestion.highlights.length === 0 && (
            <div className="gemma-status gemma-status-clean" aria-hidden="true">
              <span>Gemma found nothing to trim here.</span>
            </div>
          )}
        {!gemmaAvailable && (
          <div className="gemma-status gemma-status-offline" aria-hidden="true">
            <span>Gemma offline — no suggestions.</span>
          </div>
        )}
      </div>
    </motion.aside>
  );
}
