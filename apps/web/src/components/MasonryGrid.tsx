import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CompactGridContext, useIsPhoneWidth } from "./compactGrid";
import { gridGapFor, justifyRows } from "./justifyRows";

// Justified rows: every row fills the width edge to edge at one shared image height, and each
// photo keeps its own aspect ratio, so panoramas just get wider.
const FALLBACK_ASPECT_RATIO = 4 / 3;
// Row height per px of the Size slider: a 3:2 photo at the target height is about as wide as
// the slider value.
const ROW_HEIGHT_PER_SIZE_PX = 0.66;
// At the largest preset each photo gets a full-width row of its own.
const LARGEST_SIZE_PRESET_PX = 760;
// One full-width portrait would fill several screens, so the single-photo layout crops it here.
// The lightbox still shows the full photo.
const MIN_FULL_WIDTH_ASPECT_RATIO = 0.75;

export default function MasonryGrid<T>({
  items,
  columnWidth,
  gap: gapProp,
  renderItem,
  keyFor,
  aspectRatioFor,
}: {
  items: T[];
  /** The Size slider's value; sets the target row height. */
  columnWidth: number;
  /** px gap between photos and between rows; by default it follows the Size slider (gridGapFor). */
  gap?: number;
  /** Second argument is the ratio to render the image at (object-cover); the row layout sets the
   *  item's width, so the image lands at the row's height. */
  renderItem: (item: T, aspectRatio: number) => ReactNode;
  keyFor: (item: T) => string;
  /** Width/height ratio. Null falls back to FALLBACK_ASPECT_RATIO. */
  aspectRatioFor?: (item: T) => number | null | undefined;
}) {
  const gap = gapProp ?? gridGapFor(columnWidth);
  const phone = useIsPhoneWidth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // Layout effect: the first paint already has the real width, so rows never jump into place.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [phone]);

  const isLargestSizePreset = columnWidth >= LARGEST_SIZE_PRESET_PX;
  const targetHeight = columnWidth * ROW_HEIGHT_PER_SIZE_PX;
  const ratios = useMemo(
    () =>
      items.map((item) => {
        const ratio = aspectRatioFor?.(item) || FALLBACK_ASPECT_RATIO;
        return isLargestSizePreset ? Math.max(ratio, MIN_FULL_WIDTH_ASPECT_RATIO) : ratio;
      }),
    // aspectRatioFor is an inline callback at every call site; a ratio only changes with its item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, isLargestSizePreset],
  );
  const rows = useMemo(() => {
    if (containerWidth <= 0) return null;
    if (isLargestSizePreset) {
      return ratios.map((ratio, i) => ({ start: i, count: 1, height: containerWidth / ratio, partial: false }));
    }
    return justifyRows(ratios, containerWidth, targetHeight, gap);
  }, [ratios, containerWidth, targetHeight, gap, isLargestSizePreset]);

  if (phone) {
    // Phone layout: square thumbnails in 3 or 4 columns with hairline gaps, reaching the screen's
    // edges past the page padding.
    return (
      <CompactGridContext.Provider value={true}>
        <div
          className="-mx-page grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${window.innerWidth < 480 ? 3 : 4}, minmax(0, 1fr))` }}
        >
          {items.map((item) => (
            <div key={keyFor(item)} className="min-w-0">
              {renderItem(item, 1)}
            </div>
          ))}
        </div>
      </CompactGridContext.Provider>
    );
  }

  const renderTile = (i: number, height: number) => {
    const item = items[i];
    return (
      // Fixed width from the row math; top-aligned so captions of different heights hang below
      // images that all share the row's height.
      <div key={keyFor(item)} className="min-w-0 shrink-0" style={{ width: ratios[i] * height }}>
        {renderItem(item, ratios[i])}
      </div>
    );
  };

  return (
    <div ref={containerRef} className="flex flex-col" style={{ rowGap: gap }}>
      {rows
        ? rows.map((row) => (
            <div key={keyFor(items[row.start])} className="flex items-start" style={{ columnGap: gap }}>
              {Array.from({ length: row.count }, (_, k) => renderTile(row.start + k, row.height))}
            </div>
          ))
        : // Not measured yet (e.g. hidden): wrap at the target height instead of guessing a width.
          items.length > 0 && (
            <div className="flex flex-wrap items-start" style={{ gap }}>
              {items.map((_, i) => renderTile(i, targetHeight))}
            </div>
          )}
    </div>
  );
}
