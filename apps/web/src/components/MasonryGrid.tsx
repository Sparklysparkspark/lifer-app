import { useEffect, useRef, useState, type ReactNode } from "react";

// CSS Grid masonry: each item spans rows sized to its estimated height (1px units) with dense
// auto-flow, so a panorama can span two columns while the browser back-fills around it.
const FALLBACK_ASPECT_RATIO = 4 / 3;
// At or above this ratio a photo is a panorama and spans two columns (3:2 landscape is 1.5).
const WIDE_ASPECT_RATIO_THRESHOLD = 1.8;
// Taller portraits are cropped to this ratio in the grid so they don't leave big gaps beside
// landscape neighbors. The lightbox still shows the full photo.
const MIN_ASPECT_RATIO = 0.75;
// 1px row units: the vertical gap is item padding, and a coarser unit would round extra space in.
const ROW_UNIT_PX = 1;

export default function MasonryGrid<T>({
  items,
  columnWidth,
  gap = 8,
  extraHeightPx = 0,
  extraHeightPxFor,
  renderItem,
  keyFor,
  aspectRatioFor,
}: {
  items: T[];
  columnWidth: number;
  /** px gap between columns and between stacked items. */
  gap?: number;
  /** Extra height every item budgets for below the image (a caption or rating row), so it
   *  doesn't overlap the item below. */
  extraHeightPx?: number;
  /** Per-item extra height on top of extraHeightPx (e.g. a camera line that wraps for some
   *  photos). Receives the real rendered column width. */
  extraHeightPxFor?: (item: T, columnWidthPx: number) => number;
  /** Second argument is the clamped ratio to render at, so layout and visual crop agree. */
  renderItem: (item: T, aspectRatio: number) => ReactNode;
  keyFor: (item: T) => string;
  /** Width/height ratio for height estimates and panorama detection. Null falls back to
   *  FALLBACK_ASPECT_RATIO (never spans two columns). */
  aspectRatioFor?: (item: T) => number | null | undefined;
}) {
  // auto-fill stretches columns past columnWidth, so measure the container and replicate its
  // column math to estimate heights from the real rendered width.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // At the largest size, force one column: auto-fill could squeeze in an uneven second one.
  const isLargestSizePreset = columnWidth >= 760;
  const numColumns = isLargestSizePreset
    ? 1
    : containerWidth > 0
      ? Math.max(1, Math.floor((containerWidth + gap) / (columnWidth + gap)))
      : 1;
  const realColumnWidth = containerWidth > 0 ? (containerWidth - gap * (numColumns - 1)) / numColumns : columnWidth;

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: isLargestSizePreset ? "1fr" : `repeat(auto-fill, minmax(${columnWidth}px, 1fr))`,
        gridAutoRows: `${ROW_UNIT_PX}px`,
        gridAutoFlow: "dense",
        columnGap: gap,
        rowGap: 0,
      }}
    >
      {items.map((item) => {
        const naturalRatio = aspectRatioFor?.(item) || FALLBACK_ASPECT_RATIO;
        const isWide = !isLargestSizePreset && naturalRatio >= WIDE_ASPECT_RATIO_THRESHOLD;
        // Only portraits are clamped; wide shots get a second column instead.
        const layoutRatio = isWide ? naturalRatio : Math.max(naturalRatio, MIN_ASPECT_RATIO);
        const renderedWidth = isWide ? realColumnWidth * 2 + gap : realColumnWidth;
        const estimatedHeight =
          renderedWidth / layoutRatio + extraHeightPx + (extraHeightPxFor?.(item, realColumnWidth) ?? 0);
        // The visible gap is this item's paddingBottom, so the span books it too.
        const rowSpan = Math.max(1, Math.ceil((estimatedHeight + gap) / ROW_UNIT_PX));
        return (
          // min-w-0 lets a long caption shrink instead of widening the track.
          <div
            key={keyFor(item)}
            className="min-w-0"
            style={{ gridColumn: isWide ? "span 2" : undefined, gridRow: `span ${rowSpan}`, paddingBottom: gap }}
          >
            {renderItem(item, layoutRatio)}
          </div>
        );
      })}
    </div>
  );
}
