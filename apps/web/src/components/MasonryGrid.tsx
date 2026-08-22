import { useEffect, useRef, useState, type ReactNode } from "react";

// Avoids CSS `column-width` multi-column layout for masonry: a rounded-corner element with
// `break-inside: avoid` inside a native CSS multi-column layout can get a visible ghost
// border/outline at the browser's own column-fragmentation boundary (a known Chromium
// rendering bug). Computing real column counts here instead sidesteps that renderer
// entirely — each column is an ordinary sibling flex container, not a CSS-fragmented
// pseudo-column, so there's nothing for that bug to attach to, and gaps are exact CSS gap
// values instead of relying on column-balancing to leave (or not leave) space. Items are
// distributed round-robin across columns rather than true shortest-column-first packing (no
// real image dimensions are known ahead of load), so column heights won't be perfectly
// balanced — that's expected, not a bug. Shared between SpeciesDetailPage's own-photo grid
// and GalleryPage's global photo gallery, which use the same sizing and layout settings.
export default function MasonryGrid<T>({
  items,
  columnWidth,
  gap = 8,
  renderItem,
  keyFor,
}: {
  items: T[];
  columnWidth: number;
  /** px gap, both between columns and between stacked items within a column. */
  gap?: number;
  renderItem: (item: T) => ReactNode;
  keyFor: (item: T) => string;
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
  items.forEach((item, i) => columns[i % columnCount].push(item));

  return (
    <div ref={containerRef} className="flex" style={{ gap }}>
      {columns.map((column, i) => (
        <div key={i} className="flex flex-1 flex-col" style={{ gap }}>
          {/* renderItem's own returned element already carries key={keyFor(item)} at each
             call site — not wrapped again here to avoid an extra, pointless DOM layer. */}
          {column.map((item) => renderItem(item))}
        </div>
      ))}
    </div>
  );
}
