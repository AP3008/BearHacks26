import { motion } from "motion/react";
import { memo } from "react";
import type { GemmaFlag, Section } from "../types";

interface Props {
  section: Section;
  heightPx: number;
  isSelected: boolean;
  isMarkedForDelete: boolean;
  gemmaFlag: GemmaFlag | undefined;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, index: number) => void;
  onPointerEnter: (e: React.PointerEvent<HTMLDivElement>, index: number) => void;
  onPointerLeave: () => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (index: number) => void;
}

function BarImpl({
  section,
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
  const isUnknown = section.sectionType === "unknown";
  return (
    <motion.div
      className={[
        "bar-group",
        `type-${section.sectionType}`,
        isSelected ? "is-selected" : "",
        isMarkedForDelete ? "is-marked" : "",
        gemmaFlag ? `has-flag flag-${gemmaFlag.severity}` : "",
        isUnknown ? "is-unknown" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: heightPx }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onPointerDown={(e) => onPointerDown(e, section.index)}
      onPointerEnter={(e) => onPointerEnter(e, section.index)}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      onDoubleClick={() => onDoubleClick(section.index)}
    >
      {gemmaFlag && <span className="bar-flag-dot" aria-hidden="true" />}
    </motion.div>
  );
}

function arePropsEqual(prev: Props, next: Props) {
  return (
    prev.section === next.section &&
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
