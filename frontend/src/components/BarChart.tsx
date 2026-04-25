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

interface SectionStack {
  id: string;
  turnNumber: number;
  sections: Section[];
  tokenCount: number;
}

interface Props {
  sections: Section[];
  selectedIndices: Set<number>;
  markedForDelete: Set<number>;
  gemmaFlagsByIndex: Record<number, GemmaFlag>;
  onSelect: (index: number, shift: boolean) => void;
  onOpenEditor: (index: number) => void;
}

export function BarChart({
  sections,
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

  const stacks = useMemo<SectionStack[]>(() => {
    const result: SectionStack[] = [];
    let current: SectionStack | null = null;
    let turnNumber = 0;

    for (const section of sections) {
      if (section.sectionType === "user" || !current) {
        turnNumber += section.sectionType === "user" ? 1 : 0;
        current = {
          id: `turn-${result.length}-${section.index}`,
          turnNumber: Math.max(1, turnNumber),
          sections: [],
          tokenCount: 0,
        };
        result.push(current);
      }
      current.sections.push(section);
      current.tokenCount += section.tokenCount;
    }

    return result;
  }, [sections]);

  const turnBySectionIndex = useMemo(() => {
    const next: Record<number, number> = {};
    for (const stack of stacks) {
      for (const section of stack.sections) next[section.index] = stack.turnNumber;
    }
    return next;
  }, [stacks]);

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
              const stackHeight = drawableHeight * 0.9 * (stack.tokenCount / maxTokens);
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
                    const rawHeight =
                      stack.tokenCount > 0
                        ? stackHeight * (s.tokenCount / stack.tokenCount)
                        : 0;
                    const heightPx = isLast
                      ? Math.max(1, cursorY - (CHART_TOP_PAD + drawableHeight - stackHeight))
                      : Math.max(1, rawHeight);
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
            <span>No removable sections — only the system prompt remains.</span>
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
