import { useCallback, useRef } from "react";

export interface UndoSnapshot {
  removedIndices: Set<number>;
  editedSections: Map<number, string>;
}

interface Args {
  applySnapshot: (snapshot: UndoSnapshot) => void;
}

export function useUndo({ applySnapshot }: Args) {
  const stackRef = useRef<UndoSnapshot[]>([]);

  const push = useCallback((snapshot: UndoSnapshot) => {
    stackRef.current.push({
      removedIndices: new Set(snapshot.removedIndices),
      editedSections: new Map(snapshot.editedSections),
    });
  }, []);

  const undo = useCallback(() => {
    const snapshot = stackRef.current.pop();
    if (snapshot) applySnapshot(snapshot);
    return snapshot != null;
  }, [applySnapshot]);

  const clear = useCallback(() => {
    stackRef.current = [];
  }, []);

  const size = useCallback(() => stackRef.current.length, []);

  return { push, undo, clear, size };
}
