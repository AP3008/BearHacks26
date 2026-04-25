import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
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
  tool_def: "Tool definition",
  user: "User message",
  assistant: "Assistant response",
  tool_call: "Tool call",
  tool_output: "Tool output",
  thinking: "Thinking",
  unknown: "Unknown",
};

function formatTokens(n: number) {
  return n.toLocaleString("en-US");
}

function formatCost(c: number) {
  if (c < 0.001) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(3)}`;
}

function clampToViewport(
  anchor: { x: number; y: number },
  size: { w: number; h: number },
) {
  const margin = 8;
  const offset = 12;
  const x = Math.min(window.innerWidth - size.w - margin, anchor.x + offset);
  const wantsBelowY = anchor.y + offset;
  const y =
    wantsBelowY + size.h > window.innerHeight - margin
      ? Math.max(margin, anchor.y - size.h - offset)
      : wantsBelowY;
  return { x: Math.max(margin, x), y };
}

export function Tooltip({ section, gemmaFlag, turnNumber, anchor }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 280, h: 160 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width !== size.w || rect.height !== size.h) {
      setSize({ w: rect.width, h: rect.height });
    }
  });

  const show = !!(section && anchor);
  const pos = show ? clampToViewport(anchor!, size) : { x: 0, y: 0 };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key={section!.index}
          ref={ref}
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
