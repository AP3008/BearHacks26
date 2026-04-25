import { memo } from "react";
import type { GemmaFlag, Section } from "../types";

interface Props {
  section: Section;
  x: number;
  y: number;
  width: number;
  heightPx: number;
  isSelected: boolean;
  isMarkedForDelete: boolean;
  gemmaFlag: GemmaFlag | undefined;
  onPointerDown: (e: React.PointerEvent<SVGGElement>, index: number) => void;
  onPointerEnter: (e: React.PointerEvent<SVGGElement>, index: number) => void;
  onPointerLeave: () => void;
  onPointerMove: (e: React.PointerEvent<SVGGElement>) => void;
  onDoubleClick: (index: number) => void;
}

function BarImpl({
  section,
  x,
  y,
  width,
  heightPx,
  isSelected,
  isMarkedForDelete,
  gemmaFlag,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onDoubleClick,
}: Props) {
  const maxVisualWidth = 96;
  const innerPad =
    width > maxVisualWidth
      ? (width - maxVisualWidth) / 2
      : Math.min(2, Math.max(0.5, width * 0.08));
  const barX = x + innerPad;
  const barW = Math.max(1, width - innerPad * 2);
  const colorVar = `var(--cl-color-${section.sectionType})`;
  const isUnknown = section.sectionType === "unknown";

  return (
    <g
      className={[
        "bar-group",
        isSelected ? "is-selected" : "",
        isMarkedForDelete ? "is-marked" : "",
        gemmaFlag ? `has-flag flag-${gemmaFlag.severity}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(e) => onPointerDown(e, section.index)}
      onPointerEnter={(e) => onPointerEnter(e, section.index)}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onDoubleClick(section.index)}
    >
      {/* Hit-target: segment-sized so stacked sections remain independently targetable. */}
      <rect
        className="bar-hit"
        x={x}
        y={y}
        width={width}
        height={heightPx}
      />
      <rect
        className="bar-fill"
        x={barX}
        y={y}
        width={barW}
        height={heightPx}
        rx={0}
        ry={0}
        fill={isUnknown ? "transparent" : colorVar}
        stroke={isUnknown ? colorVar : "none"}
        strokeWidth={isUnknown ? 1.5 : 0}
      />
      {isMarkedForDelete && (
        <line
          className="bar-strike"
          x1={barX}
          x2={barX + barW}
          y1={y + heightPx / 2}
          y2={y + heightPx / 2}
        />
      )}
      {gemmaFlag && (
        <circle
          className="bar-flag-dot"
          cx={barX + barW - Math.min(3, barW / 2)}
          cy={y + Math.max(3, Math.min(6, heightPx / 2))}
          r={Math.max(2, Math.min(3, barW / 3, heightPx / 3))}
        />
      )}
    </g>
  );
}

function arePropsEqual(prev: Props, next: Props) {
  return (
    prev.section === next.section &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.heightPx === next.heightPx &&
    prev.isSelected === next.isSelected &&
    prev.isMarkedForDelete === next.isMarkedForDelete &&
    prev.gemmaFlag === next.gemmaFlag &&
    prev.onPointerDown === next.onPointerDown &&
    prev.onPointerEnter === next.onPointerEnter &&
    prev.onPointerLeave === next.onPointerLeave &&
    prev.onPointerMove === next.onPointerMove &&
    prev.onDoubleClick === next.onDoubleClick
  );
}

export const Bar = memo(BarImpl, arePropsEqual);
