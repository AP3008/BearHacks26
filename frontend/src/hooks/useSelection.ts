import { useCallback, useState } from "react";

export function useSelection() {
  const [selectedIndices, setSelected] = useState<Set<number>>(new Set());
  const [markedForDelete, setMarked] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const select = useCallback((index: number) => {
    setSelected(new Set([index]));
    setAnchor(index);
  }, []);

  const rangeSelect = useCallback(
    (index: number, allIndices: number[]) => {
      // allIndices is the ordered list of selectable section indices currently
      // shown in the chart. Anchor + index are looked up in this list to build
      // the inclusive range, which is correct after deletions reorder things.
      const orderPos = (i: number) => allIndices.indexOf(i);
      const a = anchor != null ? orderPos(anchor) : -1;
      const b = orderPos(index);
      if (a === -1 || b === -1) {
        setSelected(new Set([index]));
        setAnchor(index);
        return;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      setSelected(new Set(allIndices.slice(lo, hi + 1)));
    },
    [anchor],
  );

  const markSelectedForDelete = useCallback(() => {
    setMarked((prev) => {
      const next = new Set(prev);
      for (const i of selectedIndices) next.add(i);
      return next;
    });
  }, [selectedIndices]);

  const unmark = useCallback((index: number) => {
    setMarked((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const clearMarks = useCallback(() => setMarked(new Set()), []);

  const clearAll = useCallback(() => {
    setSelected(new Set());
    setMarked(new Set());
    setAnchor(null);
  }, []);

  return {
    selectedIndices,
    markedForDelete,
    anchor,
    select,
    rangeSelect,
    markSelectedForDelete,
    unmark,
    clearMarks,
    clearAll,
  };
}
