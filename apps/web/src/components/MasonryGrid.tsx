import { useEffect, useRef, useState, type ReactNode } from "react";

// Avoids CSS `column-width` multi-column layout for masonry: a rounded-corner element with
// `break-inside: avoid` inside a native CSS multi-column layout can get a visible ghost
// border/outline at the browser's own column-fragmentation boundary (a known Chromium
// rendering bug). Computing real column counts here instead sidesteps that renderer
// entirely — each column is an ordinary sibling flex container, not a CSS-fragmented
// pseudo-column, so there's nothing for that bug to attach to, and gaps are exact CSS gap
// values instead of relying on column-balancing to leave (or not leave) space.
//
// Packing is real shortest-column-first bin packing by estimated RENDERED HEIGHT, not by item
// count — a photo's aspect ratio (from photos.width/height, captured at derivative-generation
// time) determines how tall it'll render at this grid's fixed columnWidth, and each item goes
// into whichever column is currently shortest. This matters because a couple of wide
// panoramas can inflate a column's item COUNT without inflating its actual height much — a
// round-robin/count-based distribution would still stack them unevenly. An item with no known
// aspect ratio (older captures from before this was tracked, or a still-processing upload
// placeholder) falls back to a neutral 4:3 guess rather than breaking the packing entirely.
const FALLBACK_ASPECT_RATIO = 4 / 3;

export default function MasonryGrid<T>({
  items,
  columnWidth,
  gap = 8,
  renderItem,
  keyFor,
  aspectRatioFor,
}: {
  items: T[];
  columnWidth: number;
  /** px gap, both between columns and between stacked items within a column. */
  gap?: number;
  renderItem: (item: T) => ReactNode;
  keyFor: (item: T) => string;
  /** Width/height ratio (e.g. 1.5 for a 3:2 landscape shot) this item will render at, used to
   *  estimate its height for packing. Return null/undefined for an item whose real dimensions
   *  aren't known yet — it falls back to FALLBACK_ASPECT_RATIO. Omitting this prop entirely
   *  falls back to plain round-robin distribution, for any caller with no dimension data at
   *  all. */
  aspectRatioFor?: (item: T) => number | null | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setColumnCount(Math.max(1, Math.floor(width / columnWidth)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [columnWidth]);

  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  if (aspectRatioFor) {
    const columnHeights = new Array(columnCount).fill(0);
    items.forEach((item) => {
      const ratio = aspectRatioFor(item) || FALLBACK_ASPECT_RATIO;
      const estimatedHeight = columnWidth / ratio + gap;
      let shortest = 0;
      for (let i = 1; i < columnCount; i++) {
        if (columnHeights[i] < columnHeights[shortest]) shortest = i;
      }
      columns[shortest].push(item);
      columnHeights[shortest] += estimatedHeight;
    });
  } else {
    items.forEach((item, i) => columns[i % columnCount].push(item));
  }

  return (
    <div ref={containerRef} className="flex" style={{ gap }}>
      {columns.map((column, i) => (
        // min-w-0: a flex item's default min-width is its content's intrinsic width, not 0 —
        // without this, a long unbroken caption (e.g. the camera/lens info line some items
        // show) can't ever be shrunk or clipped, forcing this whole column (and every photo
        // in it, since each item renders at 100% of its own column) wider than intended.
        <div key={i} className="flex min-w-0 flex-1 flex-col" style={{ gap }}>
          {/* renderItem's own returned element already carries key={keyFor(item)} at each
             call site — not wrapped again here to avoid an extra, pointless DOM layer. */}
          {column.map((item) => renderItem(item))}
        </div>
      ))}
    </div>
  );
}
