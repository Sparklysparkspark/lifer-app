import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const MAX_PX = 320;
const MIN_WIDTH_PX = 224;
const EDGE_PX = 8;
const GAP_PX = 4;

/** Where a popover list sits against `anchor`: below it, or above when there's more room there,
 *  at least as wide as the anchor and kept inside the window. `rows` is its content's height. */
export function anchoredBox(
  anchor: Pick<DOMRect, "top" | "bottom" | "left" | "width">,
  rows: number,
  view = { width: window.innerWidth, height: window.innerHeight },
): CSSProperties {
  const below = view.height - anchor.bottom - GAP_PX - EDGE_PX;
  const above = anchor.top - GAP_PX - EDGE_PX;
  const width = Math.min(Math.max(anchor.width, MIN_WIDTH_PX), view.width - 2 * EDGE_PX);
  const left = Math.min(Math.max(EDGE_PX, anchor.left), view.width - width - EDGE_PX);
  const up = below < (rows || MAX_PX) && above > below;
  return up
    ? { left, width, bottom: view.height - anchor.top + GAP_PX, maxHeight: Math.min(MAX_PX, above) }
    : { left, width, top: anchor.bottom + GAP_PX, maxHeight: Math.min(MAX_PX, below) };
}

/** The fixed-position box for a portaled popover while `open`, following its anchor each frame
 *  (scrolling, a layout change) and its own content's height. Null until placed. */
export function useAnchoredBox(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null> | undefined,
  boxRef: RefObject<HTMLElement | null>,
  alignRight = false,
): CSSProperties | null {
  const [box, setBox] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchorRef) return;
    let last = "";
    let frame = 0;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const rows = Math.min(boxRef.current?.scrollHeight ?? 0, MAX_PX);
      if (anchor) {
        const key = `${anchor.top},${anchor.left},${anchor.width},${rows},${window.innerWidth},${window.innerHeight}`;
        if (key !== last) {
          last = key;
          const placed = anchoredBox(anchor, rows);
          // Right-aligned boxes end at the anchor's right edge instead of starting at its left.
          setBox(alignRight ? { ...placed, left: Math.max(EDGE_PX, anchor.right - Number(placed.width)) } : placed);
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [open, anchorRef, boxRef, alignRight]);
  return open ? box : null;
}
