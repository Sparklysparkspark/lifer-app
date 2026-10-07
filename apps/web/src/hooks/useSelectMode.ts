import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// Shared grid select mode: shift-click selects a range, click-and-drag selects what the pointer
// passes over. Indices are positions in `items`. Callbacks are stable for memoized tiles.
export function useSelectMode<T>(items: T[] | null, getId: (item: T) => string, initialSelectMode = false) {
  const [selectMode, setSelectMode] = useState(initialSelectMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedIndexRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  useLayoutEffect(() => {
    itemsRef.current = items;
    getIdRef.current = getId;
  });

  const idsBetween = useCallback((a: number, b: number): string[] => {
    const list = itemsRef.current;
    if (!list) return [];
    const [from, to] = [a, b].sort((x, y) => x - y);
    return list.slice(from, to + 1).map(getIdRef.current);
  }, []);

  const toggle = useCallback(
    (id: string, index: number, shiftKey: boolean) => {
      const last = lastSelectedIndexRef.current;
      lastSelectedIndexRef.current = index;
      if (shiftKey && last != null && itemsRef.current) {
        const rangeIds = idsBetween(last, index);
        setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [idsBetween],
  );

  // `moved` tells a real drag apart from a plain click that starts on a tile: it turns true once
  // the pointer enters any tile other than the anchor.
  const [drag, setDrag] = useState<{ anchor: number; hover: number; moved: boolean } | null>(null);
  const dragRef = useRef(drag);

  const beginDragSelect = useCallback((index: number) => {
    dragRef.current = { anchor: index, hover: index, moved: false };
    setDrag(dragRef.current);
  }, []);

  const continueDragSelect = useCallback((index: number) => {
    const current = dragRef.current;
    if (!current) return;
    const moved = current.moved || index !== current.anchor;
    if (index === current.hover && moved === current.moved) return;
    dragRef.current = { anchor: current.anchor, hover: index, moved };
    setDrag(dragRef.current);
  }, []);

  // Only set during an actual drag; callers OR it with selectedIds to preview the range.
  const dragPreviewIds = useMemo(() => {
    if (!drag || !items || !drag.moved) return null;
    const [from, to] = [drag.anchor, drag.hover].sort((a, b) => a - b);
    return new Set(items.slice(from, to + 1).map(getId));
  }, [drag, items, getId]);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    // Callers that wire drag-select have PhotoTile skip its own click toggle, so a no-movement
    // click resolves here, with the real shiftKey from the mouseup.
    function finishDrag(e: MouseEvent) {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      const list = itemsRef.current;
      if (!current || !list) return;
      if (!current.moved) {
        const anchorItem = list[current.anchor];
        if (anchorItem) toggle(getIdRef.current(anchorItem), current.anchor, e.shiftKey);
      } else {
        const rangeIds = idsBetween(current.anchor, current.hover);
        setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
        lastSelectedIndexRef.current = current.hover;
      }
    }
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
  }, [dragging, toggle, idsBetween]);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    lastSelectedIndexRef.current = null;
  }, []);

  const exit = useCallback(() => {
    setSelectMode(false);
    clear();
  }, [clear]);

  const dragProps = useMemo(
    () => ({ onDragSelectStart: beginDragSelect, onDragSelectEnter: continueDragSelect }),
    [beginDragSelect, continueDragSelect],
  );

  return {
    selectMode,
    setSelectMode,
    selectedIds,
    setSelectedIds,
    toggle,
    clear,
    exit,
    dragPreviewIds,
    /** Per tile: `onDragSelectStart={() => dragProps.onDragSelectStart(i)}`. */
    dragProps,
  };
}
