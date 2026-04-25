import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GemmaFlag, Section } from "../types";
import { Bar } from "./Bar";
import { Tooltip } from "./Tooltip";
import "./BarChart.css";

const MIN_BAR_WIDTH = 18;
const STICK_THRESHOLD_PX = 24;
const CHART_TOP_PAD = 28;
const CHART_BOTTOM_PAD = 18;
// Minimum clickable bar height. Without this, a tiny tool_call inside a
// large stack rounds down to 1px — visible but impossible to hit, which
// stranded users who wanted to inspect/delete those sections.
const MIN_BAR_HEIGHT = 12;

/**
 * Distribute `targetStackPx` pixels across N sections proportionally to their
 * token counts, while guaranteeing every bar gets at least `minPx`.
 *
 * Strategy: assign proportionally, clamp anything below `minPx` to `minPx`,
 * then redistribute the deficit by shrinking the still-unclamped bars
 * (proportionally to *their* token counts). Repeat until stable. If the stack
 * itself is too short to fit `n × minPx`, grow it — visual fidelity at the
 * low end loses to clickability.
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
  // Visible sections (post-removal, with edits applied).
  sections: Section[];
  // Full original section list. Used purely to derive stable turn
  // boundaries — if we let the visible list drive grouping, deleting a
  // `user` section would dissolve its boundary and cause neighboring
  // stacks to silently merge into one.
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
  const [chartHeight, setChartHeight] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const stickRightRef = useRef(true);

  // Measure container so bar width math reacts to layout changes.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
      setChartHeight(el.clientHeight);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    setChartHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Stable turn assignment — derived from the ORIGINAL (unfiltered) section
  // list so deleting a section never moves another section's bar. Without
  // this, removing a `user` section would erase its boundary and the next
  // turn would silently merge into the previous one's stack.
  //
  // Per-block sections (one section per content block) mean a user message
  // with [text, tool_result] now produces two `user`/`tool_output` sections.
  // We dedupe via messageIndex so each parent message contributes at most
  // ONE turn boundary — without this, multi-block user messages would split
  // into multiple turns and the chart would lie about how many prompts the
  // conversation has.
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
      // 0 = "preamble" (system + tool_def before any user message). It's
      // folded into turn 1 below so the chart shows N user prompts as N
      // bars rather than N+1.
      map[s.index] = firstUserSeen ? turn : 0;
    }
    return map;
  }, [allSections]);

  const stacks = useMemo<SectionStack[]>(() => {
    // Discover which turns exist in the original list (preserves bars for
    // turns whose only visible section happens to be the user message that
    // was just deleted — they'd otherwise vanish).
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

    // Fold preamble into turn 1 if any real turns exist (system/tool_defs
    // ride along with the first user prompt's bar).
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
      // Skip turns the user emptied entirely — preserves stable bar
      // identity for the rest, but doesn't render an empty placeholder.
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

  const count = stacks.length;
  const naturalWidth = count > 0 ? containerWidth / count : 0;
  const barWidth = Math.max(MIN_BAR_WIDTH, naturalWidth);
  const isScrollMode = barWidth === MIN_BAR_WIDTH && count * MIN_BAR_WIDTH > containerWidth;
  const innerWidth = isScrollMode ? count * MIN_BAR_WIDTH : containerWidth;

  const maxTokens = useMemo(() => {
    let max = 1;
    for (const stack of stacks) if (stack.tokenCount > max) max = stack.tokenCount;
    return max;
  }, [stacks]);

  // Track whether the user is at the right edge so we can decide whether to
  // auto-scroll on new bars (FR-4.8). If they've scrolled left, leave them be.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distFromRight = el.scrollWidth - (el.scrollLeft + el.clientWidth);
    stickRightRef.current = distFromRight <= STICK_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    if (!isScrollMode) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (stickRightRef.current) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [count, isScrollMode]);

  // Pointer events — bound on each bar but resolved through stable refs to
  // keep memoized children from re-rendering unnecessarily.
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
  // Turn number heuristic: count the user-message bars up to and including
  // this index. Good enough for tooltips; a real turn counter would come from
  // the proxy.
  const turnNumber = useMemo(() => {
    if (!hoverSection) return 0;
    return turnBySectionIndex[hoverSection.index] ?? 1;
  }, [turnBySectionIndex, hoverSection]);

  const drawableHeight = Math.max(1, chartHeight - CHART_TOP_PAD - CHART_BOTTOM_PAD);

  return (
    <div className="bar-chart">
      <div
        ref={scrollerRef}
        className={`chart-scroll ${isScrollMode ? "is-scroll-mode" : ""}`}
        onScroll={onScroll}
      >
        <svg
          width={innerWidth}
          height="100%"
          viewBox={`0 0 ${innerWidth} ${chartHeight || 1}`}
          preserveAspectRatio="none"
          className="chart-svg"
        >
          {/* Horizontal reference lines at 25 / 50 / 75 % of peak */}
          {chartHeight > 0 && [0.25, 0.5, 0.75].map((frac) => {
            const gy = CHART_TOP_PAD + drawableHeight * (1 - frac * 0.9);
            return (
              <line
                key={frac}
                className="chart-grid-line"
                x1={0} x2={innerWidth}
                y1={gy} y2={gy}
              />
            );
          })}
          <AnimatePresence initial={false}>
            {stacks.map((stack, stackIndex) => {
              const x = stackIndex * barWidth;
              const targetStackHeight = drawableHeight * 0.9 * (stack.tokenCount / maxTokens);
              const heights = distributeBarHeights(
                stack.sections.map((s) => s.tokenCount),
                targetStackHeight,
                MIN_BAR_HEIGHT,
              );
              const actualStackHeight = heights.reduce((sum, h) => sum + h, 0);
              let cursorY = CHART_TOP_PAD + drawableHeight;
              return (
                <motion.g
                  key={stack.id}
                  className="stack-group"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  {stack.sections.map((s, sectionIndex) => {
                    const isLast = sectionIndex === stack.sections.length - 1;
                    // Last bar absorbs any rounding so the stack lines up
                    // exactly with the cumulative `actualStackHeight` floor.
                    const heightPx = isLast
                      ? Math.max(
                          MIN_BAR_HEIGHT,
                          cursorY - (CHART_TOP_PAD + drawableHeight - actualStackHeight),
                        )
                      : heights[sectionIndex];
                    cursorY -= heightPx;
                    return (
                      <Bar
                        key={s.index}
                        section={s}
                        x={x}
                        y={cursorY}
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
