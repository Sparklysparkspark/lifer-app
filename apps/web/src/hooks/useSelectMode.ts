import { useEffect, useMemo, useRef, useState } from "react";

// Consolidates the select-mode logic that used to be independently reimplemented on every
// page with a photo grid (Gallery, SpeciesDetail, TrashedPhotos, Trip — Album didn't have it at
// all until this session). Two distinct multi-select gestures, both Finder/Photos-style:
// shift-click extends the selection as a RANGE from the last-clicked tile; click-and-drag
// selects everything the pointer passes over while held down (rubber-band-lite, no visible
// marquee box). `dragOccurred` is what tells a genuine drag apart from a plain click that
// happens to start on a tile (mousedown+mouseup with no movement) — a plain click still just
// toggles that one tile, matching every other click-to-select surface in the app.
//
// `items`/`getId` describe whatever list this grid is currently showing (already sorted/
// filtered by the caller) — indices here are always positions into THAT array, so a caller's own
// lightbox index and this hook's selection indices always agree.
export function useSelectMode<T>(items: T[] | null, getId: (item: T) => string, initialSelectMode = false) {
  const [selectMode, setSelectMode] = useState(initialSelectMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  function toggle(id: string, index: number, shiftKey: boolean) {
    if (shiftKey && lastSelectedIndex != null && items) {
      const [from, to] = [lastSelectedIndex, index].sort((a, b) => a - b);
      const rangeIds = items.slice(from, to + 1).map(getId);
      setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
      setLastSelectedIndex(index);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelectedIndex(index);
  }

  const [dragAnchorIndex, setDragAnchorIndex] = useState<number | null>(null);
  const [dragHoverIndex, setDragHoverIndex] = useState<number | null>(null);
  const dragOccurredRef = useRef(false);

  function beginDragSelect(index: number) {
    dragOccurredRef.current = false;
    setDragAnchorIndex(index);
    setDragHoverIndex(index);
  }

  function continueDragSelect(index: number) {
    if (dragAnchorIndex == null) return;
    if (index !== dragAnchorIndex) dragOccurredRef.current = true;
    setDragHoverIndex(index);
  }

  // Only set while an actual drag (not a plain click) is in progress — a caller ORs this
  // against `selectedIds.has(id)` to show the range highlighted before mouseup commits it.
  const dragPreviewIds = useMemo(() => {
    if (dragAnchorIndex == null || dragHoverIndex == null || !items || !dragOccurredRef.current) return null;
    const [from, to] = [dragAnchorIndex, dragHoverIndex].sort((a, b) => a - b);
    return new Set(items.slice(from, to + 1).map(getId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragAnchorIndex, dragHoverIndex, items]);

  useEffect(() => {
    if (dragAnchorIndex == null) return;
    // A caller that wires up drag-select (GalleryPage) has PhotoTile skip its own plain-click
    // toggle entirely (see PhotoTile's own onClick — it defers to this hook whenever
    // onDragSelectStart is provided), so THIS is the only place a no-drag-occurred click ever
    // resolves. finishDrag used to call toggle(...) with a hardcoded `false` for shiftKey,
    // silently discarding whether the user was actually holding Shift — shift-click range-select
    // never worked at all on any page using drag-select. The native mouseup event this listener
    // receives already carries the real shiftKey state; just read it.
    function finishDrag(e: MouseEvent) {
      if (dragAnchorIndex == null || !items) return;
      if (!dragOccurredRef.current) {
        const anchorItem = items[dragAnchorIndex];
        if (anchorItem) toggle(getId(anchorItem), dragAnchorIndex, e.shiftKey);
      } else if (dragHoverIndex != null) {
        const [from, to] = [dragAnchorIndex, dragHoverIndex].sort((a, b) => a - b);
        const rangeIds = items.slice(from, to + 1).map(getId);
        setSelectedIds((prev) => new Set([...prev, ...rangeIds]));
        setLastSelectedIndex(dragHoverIndex);
      }
      setDragAnchorIndex(null);
      setDragHoverIndex(null);
    }
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragAnchorIndex, dragHoverIndex, items]);

  function selectAll() {
    if (!items) return;
    setSelectMode(true);
    setSelectedIds(new Set(items.map(getId)));
  }

  function clear() {
    setSelectedIds(new Set());
    setLastSelectedIndex(null);
  }

  function exit() {
    setSelectMode(false);
    clear();
  }

  return {
    selectMode,
    setSelectMode,
    selectedIds,
    setSelectedIds,
    toggle,
    selectAll,
    clear,
    exit,
    dragPreviewIds,
    /** Spread onto each PhotoTile — `onDragSelectStart={dragProps.onDragSelectStart(i)}`. */
    dragProps: { onDragSelectStart: beginDragSelect, onDragSelectEnter: continueDragSelect },
  };
}
