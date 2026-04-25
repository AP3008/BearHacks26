import { AnimatePresence, motion } from "motion/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GemmaFlag, Section } from "../types";
import { Bar } from "./Bar";
import { Tooltip } from "./Tooltip";
import "./BarChart.css";

// Each turn (each user prompt) gets its own column at this width. Wide enough
// that two columns next to each other read as two bars rather than "the chart
// got cut in half".
const COLUMN_WIDTH = 110;
const COLUMN_GAP = 14;
const LABEL_HEIGHT = 22;
const STICK_THRESHOLD_PX = 24;
const TOP_PAD = LABEL_HEIGHT + 8;
const BOTTOM_PAD = 16;
const MIN_BAR_HEIGHT = 12;
// Visual density: how tall (in pixels) one token is. Fixed scaling — a 10k
// system prompt is taller than the viewport on purpose, so it overflows and
// the user can scroll up to read it at the top of the bar.
const PX_PER_TOKEN = 0.1;

/**
 * Distribute `targetStackPx` pixels across N sections proportionally to their
 * token counts, while guaranteeing every bar gets at least `minPx`.
 */
function distributeBarHeights(
  tokens: number[],
  targetStackPx: number,
  minPx: number,
): number[] {
  const n = tokens.length;
  if (n === 0) return [];
  const totalTokens = tokens.reduce((sum, t) => sum + t, 0);
  const stackPx = Math.max(targetStackPx, n * minPx);
  if (totalTokens <= 0) return new Array(n).fill(stackPx / n);

  const heights = tokens.map((t) => stackPx * (t / totalTokens));
  const clamped = new Array(n).fill(false);

  for (let iter = 0; iter < n; iter++) {
    let didClamp = false;
    for (let i = 0; i < n; i++) {
      if (!clamped[i] && heights[i] < minPx) {
        heights[i] = minPx;
        clamped[i] = true;
        didClamp = true;
      }
    }
    if (!didClamp) break;

    let clampedPx = 0;
    let unclampedTokens = 0;
    for (let i = 0; i < n; i++) {
      if (clamped[i]) clampedPx += heights[i];
      else unclampedTokens += tokens[i];
    }
    const remainingPx = stackPx - clampedPx;
    if (remainingPx <= 0 || unclampedTokens <= 0) {
      for (let i = 0; i < n; i++) if (!clamped[i]) heights[i] = minPx;
      break;
    }
    for (let i = 0; i < n; i++) {
      if (!clamped[i]) heights[i] = remainingPx * (tokens[i] / unclampedTokens);
    }
  }
  return heights;
}

interface SectionStack {
  id: string;
  turnNumber: number;
  sections: Section[];
  tokenCount: number;
}

interface Props {
  sections: Section[];
  allSections: Section[];
  selectedIndices: Set<number>;
  markedForDelete: Set<number>;
  gemmaFlagsByIndex: Record<number, GemmaFlag>;
  onSelect: (index: number, shift: boolean) => void;
  onOpenEditor: (index: number) => void;
}

export function BarChart({
  sections,
  allSections,
  selectedIndices,
  markedForDelete,
  gemmaFlagsByIndex,
  onSelect,
  onOpenEditor,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const stickRightRef = useRef(true);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Stable turn assignment derived from the original (unfiltered) section
  // list — see prior comments for why deletion-induced merging matters.
  const turnBySectionIndex = useMemo(() => {
    const map: Record<number, number> = {};
    let turn = 0;
    let firstUserSeen = false;
    let lastTurnedMessageIdx = -1;
    for (const s of allSections) {
      const msgIdx = s.messageIndex ?? -1;
      if (s.sectionType === "user" && msgIdx !== lastTurnedMessageIdx) {
        turn += 1;
        firstUserSeen = true;
        lastTurnedMessageIdx = msgIdx;
      }
      map[s.index] = firstUserSeen ? turn : 0;
    }
    return map;
  }, [allSections]);

  const stacks = useMemo<SectionStack[]>(() => {
    let totalTurns = 0;
    let hasPreamble = false;
    for (const s of allSections) {
      const t = turnBySectionIndex[s.index] ?? 0;
      if (t === 0) hasPreamble = true;
      else if (t > totalTurns) totalTurns = t;
    }

    const buckets = new Map<number, Section[]>();
    if (totalTurns === 0 && hasPreamble) buckets.set(0, []);
    for (let t = 1; t <= totalTurns; t++) buckets.set(t, []);

    const targetForPreamble = totalTurns >= 1 ? 1 : 0;

    for (const s of sections) {
      const raw = turnBySectionIndex[s.index] ?? 0;
      const target = raw === 0 ? targetForPreamble : raw;
      const bucket = buckets.get(target);
      if (bucket) bucket.push(s);
    }

    const result: SectionStack[] = [];
    const orderedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const t of orderedKeys) {
      const secs = buckets.get(t) ?? [];
      if (secs.length === 0) continue;
      const tokenCount = secs.reduce((sum, s) => sum + s.tokenCount, 0);
      result.push({
        id: `turn-${t}`,
        turnNumber: t === 0 ? 1 : t,
        sections: secs,
        tokenCount,
      });
    }
    return result;
  }, [allSections, sections, turnBySectionIndex]);

  // Per-stack heights. Each stack's pixel height is fixed at its token count
  // * PX_PER_TOKEN — so a long system prompt produces a tall column that
  // overflows the viewport vertically.
  const stackLayouts = useMemo(() => {
    return stacks.map((stack) => {
      const targetStackPx = stack.tokenCount * PX_PER_TOKEN;
      const heights = distributeBarHeights(
        stack.sections.map((s) => s.tokenCount),
        targetStackPx,
        MIN_BAR_HEIGHT,
      );
      const total = heights.reduce((sum, h) => sum + h, 0);
      return { stack, heights, total };
    });
  }, [stacks]);

  const maxStackHeight = useMemo(
    () => stackLayouts.reduce((m, sl) => Math.max(m, sl.total), 0),
    [stackLayouts],
  );

  const count = stacks.length;
  // Each turn = its own fixed-width column with a gap between. Columns DON'T
  // scale to fill — the user expects "one new bar per user prompt", which only
  // reads visually if the columns stay the same size as new ones append.
  const barWidth = COLUMN_WIDTH;
  const totalColumnsWidth = count > 0 ? count * barWidth + (count - 1) * COLUMN_GAP : 0;
  const innerWidth = Math.max(containerWidth, totalColumnsWidth + 16);
  const svgHeight = TOP_PAD + maxStackHeight + BOTTOM_PAD;

  // Track stick state in BOTH axes. Horizontal: pinned to the right so the
  // newest turn stays in view. Vertical: pinned to the bottom so the newest
  // section stays in view; scroll up to see system prompt at the top.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distFromRight = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    stickRightRef.current = distFromRight <= STICK_THRESHOLD_PX;
  }, []);

  const totalSections = sections.length;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Always pin to bottom on update — newest content stays in view.
    el.scrollTop = el.scrollHeight;
    if (stickRightRef.current) el.scrollLeft = el.scrollWidth;
  }, [count, totalSections, maxStackHeight]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, index: number) => {
      if (e.button !== 0) return;
      onSelect(index, e.shiftKey);
    },
    [onSelect],
  );

  const onPointerEnter = useCallback(
    (e: React.PointerEvent<SVGGElement>, index: number) => {
      setHoverIndex(index);
      setHoverPos({ x: e.clientX, y: e.clientY });
    },
    [],
  );
  const onPointerMove = useCallback((e: React.PointerEvent<SVGGElement>) => {
    setHoverPos({ x: e.clientX, y: e.clientY });
  }, []);
  const onPointerLeave = useCallback(() => {
    setHoverIndex(null);
    setHoverPos(null);
  }, []);
  const onDoubleClick = useCallback(
    (index: number) => {
      setHoverIndex(null);
      setHoverPos(null);
      onOpenEditor(index);
    },
    [onOpenEditor],
  );

  const hoverSection = useMemo(
    () => sections.find((s) => s.index === hoverIndex) ?? null,
    [sections, hoverIndex],
  );
  const turnNumber = useMemo(() => {
    if (!hoverSection) return 0;
    return turnBySectionIndex[hoverSection.index] ?? 1;
  }, [turnBySectionIndex, hoverSection]);

  return (
    <div className="bar-chart">
      <div ref={scrollerRef} className="chart-scroll" onScroll={onScroll}>
        <svg
          width={innerWidth}
          height={Math.max(svgHeight, 1)}
          viewBox={`0 0 ${innerWidth} ${Math.max(svgHeight, 1)}`}
          className="chart-svg"
        >
          <AnimatePresence initial={false}>
            {stackLayouts.map(({ stack, heights }, stackIndex) => {
              const x = stackIndex * (barWidth + COLUMN_GAP);
              // Top-anchored columns: cursor starts at TOP_PAD and grows
              // downward. Sections render in chronological order — system at
              // top, tool_calls/assistant/tool_output appended below.
              let cursorY = TOP_PAD;
              return (
                <motion.g
                  key={stack.id}
                  className="stack-group"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  <text
                    className="column-label"
                    x={x + barWidth / 2}
                    y={LABEL_HEIGHT - 6}
                    textAnchor="middle"
                  >
                    {`TURN ${stack.turnNumber}`}
                  </text>
                  {stack.sections.map((s, sectionIndex) => {
                    const heightPx = heights[sectionIndex];
                    const y = cursorY;
                    cursorY += heightPx;
                    return (
                      <Bar
                        key={s.index}
                        section={s}
                        x={x}
                        y={y}
                        width={barWidth}
                        heightPx={heightPx}
                        isSelected={selectedIndices.has(s.index)}
                        isMarkedForDelete={markedForDelete.has(s.index)}
                        gemmaFlag={gemmaFlagsByIndex[s.index]}
                        onPointerDown={onPointerDown}
                        onPointerEnter={onPointerEnter}
                        onPointerLeave={onPointerLeave}
                        onPointerMove={onPointerMove}
                        onDoubleClick={onDoubleClick}
                      />
                    );
                  })}
                </motion.g>
              );
            })}
          </AnimatePresence>
        </svg>
        {count === 0 && (
          <div className="chart-empty">
            <span>No sections remain in this request.</span>
          </div>
        )}
      </div>
      <Tooltip
        section={hoverSection}
        gemmaFlag={hoverSection ? gemmaFlagsByIndex[hoverSection.index] : undefined}
        turnNumber={turnNumber}
        anchor={hoverPos}
      />
    </div>
  );
}
