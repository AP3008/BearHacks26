import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";
import type { GemmaFlag, Section } from "../types";
import { Bar } from "./Bar";

interface Props {
  turnNumber: number;
  sections: Section[];
  heights: number[];
  selectedIndices: Set<number>;
  markedForDelete: Set<number>;
  gemmaFlagsByIndex: Record<number, GemmaFlag>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, index: number) => void;
  onPointerEnter: (e: React.PointerEvent<HTMLDivElement>, index: number) => void;
  onPointerLeave: () => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: (index: number) => void;
}

function TurnBarImpl({
  turnNumber,
  sections,
  heights,
  selectedIndices,
  markedForDelete,
  gemmaFlagsByIndex,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onPointerMove,
  onDoubleClick,
}: Props) {
  return (
    <motion.div
      className="turn-bar"
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0.2, 1] }}
    >
      <div className="turn-bar-label" aria-hidden="true">
        Turn {turnNumber}
      </div>
      <div className="turn-bar-sections">
        <AnimatePresence initial={false}>
          {sections.map((s, i) => (
            <Bar
              key={s.index}
              section={s}
              heightPx={heights[i]}
              isSelected={selectedIndices.has(s.index)}
              isMarkedForDelete={markedForDelete.has(s.index)}
              gemmaFlag={gemmaFlagsByIndex[s.index]}
              onPointerDown={onPointerDown}
              onPointerEnter={onPointerEnter}
              onPointerLeave={onPointerLeave}
              onPointerMove={onPointerMove}
              onDoubleClick={onDoubleClick}
            />
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

export const TurnBar = memo(TurnBarImpl);
