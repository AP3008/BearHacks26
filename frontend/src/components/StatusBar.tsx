import { useEffect, useState } from "react";
import type { Mode } from "../types";
import "./StatusBar.css";

interface Props {
  mode: Mode;
  paused: boolean;
  held: boolean;
  totalTokens: number;
  totalCost: number;
  hasEdits: boolean;
  canUndo: boolean;
  gemmaUnavailable: boolean;
  onModeChange: (mode: Mode) => void;
  onTogglePause: () => void;
  onSend: () => void;
  onUndo: () => void;
}

const HOLD_WARNING_MS = 30_000;

function formatTokens(n: number) {
  if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

function formatCost(c: number) {
  if (c < 0.001) return c.toFixed(4);
  return c.toFixed(3);
}

export function StatusBar({
  mode,
  paused,
  held,
  totalTokens,
  totalCost,
  hasEdits,
  canUndo,
  gemmaUnavailable,
  onModeChange,
  onTogglePause,
  onSend,
  onUndo,
}: Props) {
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setShowWarning(true), HOLD_WARNING_MS);
    return () => {
      clearTimeout(t);
      setShowWarning(false);
    };
  }, [held]);

  return (
    <footer className="status-bar">
      {showWarning && held && (
        <div className="warning-banner" role="alert">
          <span className="warning-icon" aria-hidden="true">!</span>
          Claude Code may timeout. Send or cancel.
        </div>
      )}
      {gemmaUnavailable && (
        <div className="gemma-notice" role="status">
          Install Ollama + Gemma 4 for smart suggestions.
        </div>
      )}
      <div className="status-row">
        <div className="status-stats">
          <span className="stat">
            <span className="stat-label">Tokens</span>
            <span className="stat-value">
              {formatTokens(totalTokens)}
              {hasEdits && <span className="estimate"> est</span>}
            </span>
          </span>
          <span className="stat">
            <span className="stat-label">Cost</span>
            <span className="stat-value">${formatCost(totalCost)}</span>
          </span>
        </div>

        <div className="status-controls">
          <div className="mode-toggle" role="radiogroup" aria-label="Send mode">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "auto_send"}
              className={mode === "auto_send" ? "active" : ""}
              onClick={() => onModeChange("auto_send")}
            >
              Auto-send
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "ask_permission"}
              className={mode === "ask_permission" ? "active" : ""}
              onClick={() => onModeChange("ask_permission")}
            >
              Ask permission
            </button>
          </div>

          <button
            type="button"
            className={`btn ${paused ? "active" : ""}`}
            onClick={onTogglePause}
            title={
              paused ? "Paused — next prompt will be held" : "Pause next prompt"
            }
          >
            {paused ? "Paused — next prompt held" : "Pause"}
          </button>

          <button
            type="button"
            className="btn"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo last deletion (Ctrl/Cmd+Z)"
          >
            Undo
          </button>

          {held && (
            <button
              type="button"
              className="btn primary send"
              onClick={onSend}
              autoFocus
            >
              Send
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
