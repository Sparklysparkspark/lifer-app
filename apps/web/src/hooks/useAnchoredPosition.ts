import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

const GAP = 4;
const MARGIN = 8;

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
  width?: number;
}

/** Where a panel of `panel`'s size goes next to `anchor`: below it, or above when there's more room
 *  there, with one edge lined up with the anchor and the whole panel inside the window. */
export function placeBeside(
  anchor: DOMRect,
  panel: { width: number; height: number },
  view: { width: number; height: number },
  align: "left" | "right",
): { top: number; left: number; maxHeight: number } {
  const below = view.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = panel.height > below && above > below;
  const maxHeight = Math.max(0, up ? above : below);
  const height = Math.min(panel.height, maxHeight);
  const top = up ? anchor.top - GAP - height : anchor.bottom + GAP;
  const wanted = align === "right" ? anchor.right - panel.width : anchor.left;
  const left = Math.max(MARGIN, Math.min(wanted, view.width - panel.width - MARGIN));
  return { top, left, maxHeight };
}

/** Fixed-position style for a panel portaled to the top layer, so a scrolling or overflow-hidden
 *  parent (a dialog body, a card) never clips it. Follows the anchor on scroll and resize. */
export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  {
    align = "left",
    matchWidth = false,
    maxHeight = Infinity,
  }: { align?: "left" | "right"; matchWidth?: boolean; maxHeight?: number } = {},
): CSSProperties {
  const [placement, setPlacement] = useState<Placement | null>(null);
  if (!open && placement !== null) setPlacement(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = matchWidth ? Math.max(anchor.width, panel.offsetWidth) : panel.offsetWidth;
      // scrollHeight is the content's full height even while maxHeight caps the box.
      const height = Math.min(maxHeight, Math.max(panel.offsetHeight, panel.scrollHeight));
      const next: Placement = {
        ...placeBeside(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }, align),
        width: matchWidth ? anchor.width : undefined,
      };
      next.maxHeight = Math.min(next.maxHeight, maxHeight);
      setPlacement((prev) =>
        prev &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.left - next.left) < 0.5 &&
        Math.abs(prev.maxHeight - next.maxHeight) < 0.5 &&
        prev.width === next.width
          ? prev
          : next,
      );
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(panel);
    // Capture, so a scrolling dialog body moves the panel along with its trigger.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, panelRef, open, align, matchWidth, maxHeight]);

  const base: CSSProperties = { position: "fixed", right: "auto", bottom: "auto", margin: 0, overflowY: "auto" };
  return placement
    ? {
        ...base,
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: `calc(100vw - ${2 * MARGIN}px)`,
        ...(placement.width !== undefined && { minWidth: placement.width }),
      }
    : // First paint, before measuring: hidden, so it never flashes at the corner.
      { ...base, top: 0, left: 0, visibility: "hidden" };
}
