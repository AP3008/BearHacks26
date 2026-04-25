import type { Section } from "../types";
import "./SystemHeader.css";

interface Props {
  section: Section | null;
  onOpen: (index: number) => void;
}

function formatCost(c: number) {
  if (c < 0.001) return c.toFixed(4);
  return c.toFixed(3);
}

export function SystemHeader({ section, onOpen }: Props) {
  if (!section) {
    return (
      <div className="system-header is-empty">
        <span className="badge">SYSTEM</span>
        <span className="muted">No system prompt in this request</span>
      </div>
    );
  }
  return (
    <div
      className="system-header"
      role="button"
      tabIndex={0}
      title="Double-click to open the system prompt in the editor (advanced)"
      onDoubleClick={() => onOpen(section.index)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen(section.index);
      }}
    >
      <span className="badge">SYSTEM</span>
      <span className="text">
        <strong>{section.tokenCount.toLocaleString()}</strong> tokens
      </span>
      <span className="dot" />
      <span className="text muted">${formatCost(section.cost)}</span>
      <span className="hint">double-click to edit</span>
    </div>
  );
}
