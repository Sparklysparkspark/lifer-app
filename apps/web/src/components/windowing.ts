import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { scrollShiftAbove, visibleRows } from "./justifyRows";

/** Row geometry in the list's own coordinates. A new `structure` means different rows, not just
 *  new heights for the same ones. */
export type WindowLayout = { structure: unknown; tops: number[]; heights: number[] };

/** Rows to mount (inclusive) for a list that scrolls with the window: those within `mount`
 *  screens above and below the view. The window only moves once fewer than `mount - 1` screens
 *  remain mounted past an edge, so small scrolls don't re-render. Also keeps the view still when
 *  rows above it change height: WebKit has no CSS scroll anchoring, and the list sets
 *  `overflow-anchor: none` so Chrome's doesn't correct a second time. */
export function useWindowRange(
  containerRef: RefObject<HTMLElement | null>,
  layout: WindowLayout | null,
  mount: { above: number; below: number },
): [number, number] | null {
  const prevLayout = useRef<WindowLayout | null>(null);
  // Before paint, so the shifted frame never shows.
  useLayoutEffect(() => {
    const prev = prevLayout.current;
    prevLayout.current = layout;
    const el = containerRef.current;
    if (!prev || !layout || !el || prev.structure !== layout.structure) return;
    const shift = scrollShiftAbove(prev.tops, prev.heights, layout.heights, -el.getBoundingClientRect().top);
    if (shift !== 0) window.scrollBy(0, shift);
  }, [layout, containerRef]);

  const [range, setRange] = useState<[number, number] | null>(null);
  const { above, below } = mount;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!layout || !el) return;
    const { tops, heights } = layout;
    const update = (force: boolean) => {
      const screen = window.innerHeight;
      const top = -el.getBoundingClientRect().top;
      setRange((current) => {
        if (!force && current) {
          const [first, last] = visibleRows(tops, heights, top - (above - 1) * screen, top + below * screen);
          if (first >= current[0] && last <= current[1]) return current;
        }
        const next = visibleRows(tops, heights, top - above * screen, top + (1 + below) * screen);
        return current?.[0] === next[0] && current[1] === next[1] ? current : next;
      });
    };
    update(true);
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), update(false)));
    };
    const onResize = () => update(true);
    // Capture too, so a list scrolling inside a dialog (not the window) still mounts its rows.
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", onResize);
    // Content above the list (a map, a banner) can load and push it down without a scroll.
    const page = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    page?.observe(document.body);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      page?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [layout, containerRef, above, below]);
  return range;
}
