import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useState } from "react";
import type { Mode } from "../types";
import "./StatusBar.css";

interface Props {
  mode: Mode;
  paused: boolean;
  held: boolean;
  // Number of additional requests waiting behind the current one. Renders as
  // a "+N held" badge so the user knows acting on the visible request will
  // not unblock the proxy entirely. 0 = no badge.
  queueLength: number;
  totalTokens: number;
  totalCost: number;
  hasEdits: boolean;
  canUndo: boolean;
  gemmaUnavailable: boolean;
  onModeChange: (mode: Mode) => void;
  onTogglePause: () => void;
  onSend: () => void;
  onUndo: () => void;
  onResetEdits: () => void;
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
  queueLength,
  totalTokens,
  totalCost,
  hasEdits,
  canUndo,
  gemmaUnavailable,
  onModeChange,
  onTogglePause,
  onSend,
  onUndo,
  onResetEdits,
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

  // Spring-animated token and cost counters.
  const tokensMV = useMotionValue(totalTokens);
  useEffect(() => {
    const ctrl = animate(tokensMV, totalTokens, { type: "spring", stiffness: 55, damping: 18 });
    return () => ctrl.stop();
  }, [totalTokens, tokensMV]);
  const displayTokens = useTransform(tokensMV, (v) => formatTokens(Math.round(v)));

  const costMV = useMotionValue(totalCost);
  useEffect(() => {
    const ctrl = animate(costMV, totalCost, { type: "spring", stiffness: 55, damping: 18 });
    return () => ctrl.stop();
  }, [totalCost, costMV]);
  const displayCost = useTransform(costMV, (v) => formatCost(v));

  return (
    <footer className="status-bar">
      <AnimatePresence>
        {showWarning && held && (
          <motion.div
            className="warning-banner"
            role="alert"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
          >
            <span className="warning-icon" aria-hidden="true">!</span>
            Claude Code may timeout. Send or cancel.
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {gemmaUnavailable && (
          <motion.div
            className="gemma-notice"
            role="status"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
          >
            Install Ollama + Gemma 4 for smart suggestions.
          </motion.div>
        )}
      </AnimatePresence>
      <div className="status-row">
        <div className="status-stats">
          <span className="stat">
            <span className="stat-label">Tokens</span>
            <span className="stat-value">
              <motion.span>{displayTokens}</motion.span>
              {hasEdits && <span className="estimate"> est</span>}
            </span>
          </span>
          <span className="stat">
            <span className="stat-label">Cost</span>
            <span className="stat-value">$<motion.span>{displayCost}</motion.span></span>
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
            title={paused ? "Paused — next prompt will be held" : "Pause next prompt"}
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

          <button
            type="button"
            className="btn"
            onClick={onResetEdits}
            title="Clear all saved edits — future requests will use Claude Code's full context"
          >
            Reset edits
          </button>

          <AnimatePresence>
            {queueLength > 0 && (
              <motion.span
                key="queue-badge"
                className="queue-badge"
                title={`${queueLength} more request${queueLength === 1 ? "" : "s"} held in queue. Send the current one to advance.`}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ type: "spring", stiffness: 320, damping: 24 }}
              >
                +{queueLength} held
              </motion.span>
            )}
            {held && (
              <motion.button
                key="send-btn"
                type="button"
                className="btn primary send"
                onClick={onSend}
                autoFocus
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 300, damping: 24 }}
              >
                Send
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </footer>
  );
}
