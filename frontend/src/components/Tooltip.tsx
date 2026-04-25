import { AnimatePresence, motion } from "motion/react";
import type { GemmaFlag, Section } from "../types";
import "./Tooltip.css";

interface Props {
  section: Section | null;
  gemmaFlag: GemmaFlag | undefined;
  turnNumber: number;
  anchor: { x: number; y: number } | null;
}

const TYPE_LABEL: Record<string, string> = {
  system: "System prompt",
  user: "User message",
  assistant: "Assistant response",
  tool_call: "Tool call",
  tool_output: "Tool output",
  unknown: "Unknown",
};

function formatTokens(n: number) {
  return n.toLocaleString("en-US");
}

function formatCost(c: number) {
  if (c < 0.001) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(3)}`;
}

function clampToViewport(anchor: { x: number; y: number }) {
  const tooltipW = 280;
  const tooltipH = 160;
  const margin = 8;
  const x = Math.min(window.innerWidth - tooltipW - margin, anchor.x + 12);
  const y = Math.min(window.innerHeight - tooltipH - margin, anchor.y + 12);
  return { x: Math.max(margin, x), y: Math.max(margin, y) };
}

export function Tooltip({ section, gemmaFlag, turnNumber, anchor }: Props) {
  const show = !!(section && anchor);
  const pos = show ? clampToViewport(anchor!) : { x: 0, y: 0 };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key={section!.index}
          className="tooltip"
          style={{ left: pos.x, top: pos.y }}
          role="tooltip"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.1, ease: "easeOut" }}
        >
          <div className="tooltip-row tooltip-type">
            <span className={`type-dot type-${section!.sectionType}`} />
            {TYPE_LABEL[section!.sectionType] ?? section!.sectionType}
          </div>
          <div className="tooltip-row">
            <span className="tooltip-key">Tokens</span>
            <span className="tooltip-val">{formatTokens(section!.tokenCount)}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-key">Cost</span>
            <span className="tooltip-val">{formatCost(section!.cost)}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-key">Turn</span>
            <span className="tooltip-val">{turnNumber}</span>
          </div>
          <div className="tooltip-preview">{section!.contentPreview}</div>
          {gemmaFlag && (
            <div className={`tooltip-flag severity-${gemmaFlag.severity}`}>
              <span className="flag-label">Gemma</span> {gemmaFlag.reason}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
