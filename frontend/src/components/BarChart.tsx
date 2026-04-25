import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GemmaFlag, Section } from "../types";
import { Tooltip } from "./Tooltip";
import { TurnBar } from "./TurnBar";
import "./BarChart.css";

const STICK_THRESHOLD_PX = 24;
// Minimum clickable bar height. Without this, a tiny tool_call inside a
// large stack rounds down to 1px — visible but impossible to hit.
const MIN_BAR_HEIGHT = 12;
// Visual density knob: token count → pixels for a turn-bar.
const PX_PER_TOKEN = 0.6;
const MIN_TURN_HEIGHT = 48;
const MAX_TURN_HEIGHT = 480;

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const stickBottomRef = useRef(true);

  // Stable turn assignment — derived from the ORIGINAL (unfiltered) section
  // list so deleting a section never moves another section's bar. Without
  // this, removing a `user` section would erase its boundary and the next
  // turn would silently merge into the previous one's stack.
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

  // Per-turn heights: bar height tracks token count, clamped to a sane range.
  // Section heights inside the bar use distributeBarHeights so a tiny
  // tool_call still gets its 12-px click floor.
  const stackLayouts = useMemo(() => {
    return stacks.map((stack) => {
      const turnPx = clamp(
        stack.tokenCount * PX_PER_TOKEN,
        MIN_TURN_HEIGHT,
        MAX_TURN_HEIGHT,
      );
      const heights = distributeBarHeights(
        stack.sections.map((s) => s.tokenCount),
        turnPx,
        MIN_BAR_HEIGHT,
      );
      return { stack, heights };
    });
  }, [stacks]);

  // Track whether the user is at the bottom edge so we can decide whether to
  // auto-scroll on new bars. If they've scrolled up to read history, leave
  // them there.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickBottomRef.current = distFromBottom <= STICK_THRESHOLD_PX;
  }, []);

  // Pin to bottom on layout commit (before paint) to avoid a one-frame flash
  // where new content is visible without the scroll catching up.
  const totalSections = sections.length;
  const lastStackTokenCount =
    stacks.length > 0 ? stacks[stacks.length - 1].tokenCount : 0;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [stacks.length, totalSections]);
  // Re-pin once after motion's height transition settles. Cheap — only fires
  // when the latest stack actually grew.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (!stickBottomRef.current) return;
    const id = window.setTimeout(() => {
      const cur = scrollerRef.current;
      if (!cur) return;
      if (stickBottomRef.current) cur.scrollTop = cur.scrollHeight;
    }, 220);
    return () => window.clearTimeout(id);
  }, [lastStackTokenCount, totalSections]);

  // Pointer events — bound on each bar but resolved through stable refs to
  // keep memoized children from re-rendering unnecessarily.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number) => {
      if (e.button !== 0) return;
      onSelect(index, e.shiftKey);
    },
    [onSelect],
  );

  const onPointerEnter = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number) => {
      setHoverIndex(index);
      setHoverPos({ x: e.clientX, y: e.clientY });
    },
    [],
  );
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
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

  const count = stacks.length;

  return (
    <div className="bar-chart">
      <div ref={scrollerRef} className="chart-scroll" onScroll={onScroll}>
        <AnimatePresence initial={false}>
          {stackLayouts.map(({ stack, heights }) => (
            <TurnBar
              key={stack.id}
              turnNumber={stack.turnNumber}
              sections={stack.sections}
              heights={heights}
              selectedIndices={selectedIndices}
              markedForDelete={markedForDelete}
              gemmaFlagsByIndex={gemmaFlagsByIndex}
              onPointerDown={onPointerDown}
              onPointerEnter={onPointerEnter}
              onPointerLeave={onPointerLeave}
              onPointerMove={onPointerMove}
              onDoubleClick={onDoubleClick}
            />
          ))}
        </AnimatePresence>
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
