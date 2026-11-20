import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { CompactGridContext, useIsPhoneWidth } from "./compactGrid";
import { gridGapFor, justifyRows, rowTops, type JustifiedRow } from "./justifyRows";
import { useWindowRange } from "./windowing";

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
// Phone layout: hairline gaps between square thumbnails.
const PHONE_GAP_PX = 2;
// Only rows within this many screens are mounted, so a 20,000-photo library scrolls like a short one.
const MOUNT_SCREENS = { above: 2, below: 2 };
// Before the width is known (hidden, or not laid out yet) tiles wrap unmeasured.
// shortcut: only the first ones show in that state, fine while it only lasts until layout.
const UNMEASURED_TILE_CAP = 200;

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
  const phone = useIsPhoneWidth();
  const gap = phone ? PHONE_GAP_PX : (gapProp ?? gridGapFor(columnWidth));
  const phoneColumns = window.innerWidth < 480 ? 3 : 4;
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
  }, []);

  const isLargestSizePreset = columnWidth >= LARGEST_SIZE_PRESET_PX;
  const targetHeight = columnWidth * ROW_HEIGHT_PER_SIZE_PX;
  const ratios = useMemo(
    () =>
      items.map((item) => {
        if (phone) return 1;
        const ratio = aspectRatioFor?.(item) || FALLBACK_ASPECT_RATIO;
        return isLargestSizePreset ? Math.max(ratio, MIN_FULL_WIDTH_ASPECT_RATIO) : ratio;
      }),
    // aspectRatioFor is an inline callback at every call site; a ratio only changes with its item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, isLargestSizePreset, phone],
  );
  const rows = useMemo((): JustifiedRow[] | null => {
    if (containerWidth <= 0) return null;
    if (phone) {
      // Square thumbnails in 3 or 4 columns.
      const cell = (containerWidth - gap * (phoneColumns - 1)) / phoneColumns;
      return Array.from({ length: Math.ceil(ratios.length / phoneColumns) }, (_, r) => ({
        start: r * phoneColumns,
        count: Math.min(phoneColumns, ratios.length - r * phoneColumns),
        height: cell,
        partial: false,
      }));
    }
    if (isLargestSizePreset) {
      return ratios.map((ratio, i) => ({ start: i, count: 1, height: containerWidth / ratio, partial: false }));
    }
    return justifyRows(ratios, containerWidth, targetHeight, gap);
  }, [ratios, containerWidth, targetHeight, gap, isLargestSizePreset, phone, phoneColumns]);

  // Caption height (a row's height beyond its images), measured per row and keyed by the row's
  // first photo, so it survives a resize. Captions are mostly one size, so unmeasured rows borrow
  // the latest measurement and the page height stays close to the real one.
  const [extras] = useState(() => new Map<string, number>());
  const [measured, setMeasured] = useState({ version: 0, latest: 0 });
  const [rowObserver] = useState(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          let changed = false;
          let latest = 0;
          for (const { target } of entries) {
            const el = target as HTMLElement;
            const height = el.getBoundingClientRect().height;
            // Zero while hidden: nothing to learn.
            if (!height || !el.dataset.rowKey) continue;
            const extra = Math.max(0, height - Number(el.dataset.imageHeight));
            latest = extra;
            if (Math.abs((extras.get(el.dataset.rowKey) ?? -1) - extra) > 0.5) {
              extras.set(el.dataset.rowKey, extra);
              changed = true;
            }
          }
          // Synchronously, so a row above the view that measured off its estimate is compensated
          // (useWindowRange) before this frame paints.
          if (changed) flushSync(() => setMeasured((m) => ({ version: m.version + 1, latest })));
        }),
  );
  useEffect(() => () => rowObserver?.disconnect(), [rowObserver]);
  const observeRow = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !rowObserver) return;
      rowObserver.observe(el);
      return () => rowObserver.unobserve(el);
    },
    [rowObserver],
  );

  const layout = useMemo(() => {
    if (!rows) return null;
    const keys = rows.map((row) => keyFor(items[row.start]));
    const heights = rows.map((row, r) => row.height + (extras.get(keys[r]) ?? measured.latest));
    return { structure: rows, keys, heights, tops: rowTops(heights, gap) };
    // keyFor is inline at every call site; rows already change with items. `measured` bumps when extras change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, gap, measured]);

  // Mounted rows, inclusive. The page scrolls on the window, so the view is the screen measured
  // from the grid's top.
  const range = useWindowRange(containerRef, layout, MOUNT_SCREENS);

  // The row holding keyboard focus stays mounted, so scrolling away never drops focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const renderTile = (i: number, height: number) => {
    const item = items[i];
    return (
      // Fixed width from the row math; top-aligned so captions of different heights hang below
      // images that all share the row's height.
      <div
        key={keyFor(item)}
        role="listitem"
        aria-posinset={i + 1}
        aria-setsize={items.length}
        className="min-w-0 shrink-0"
        style={{ width: ratios[i] * height }}
      >
        {renderItem(item, ratios[i])}
      </div>
    );
  };

  let content: ReactNode = null;
  if (rows && layout) {
    const { keys, heights, tops } = layout;
    const first = range?.[0] ?? 0;
    const last = Math.min(range?.[1] ?? -1, rows.length - 1);
    const mounted: number[] = [];
    for (let r = first; r <= last; r++) mounted.push(r);
    const focused = focusKey == null ? -1 : keys.indexOf(focusKey);
    if (focused >= 0 && (focused < first || focused > last)) {
      mounted.splice(focused < first ? 0 : mounted.length, 0, focused);
    }
    // Unmounted rows between mounted ones collapse into one spacer of their exact height.
    const spacer = (a: number, b: number) => (
      <div key={`spacer-${a}`} aria-hidden style={{ height: tops[b] + heights[b] - tops[a] }} />
    );
    const children: ReactNode[] = [];
    let prev = -1;
    for (const r of mounted) {
      if (r > prev + 1) children.push(spacer(prev + 1, r - 1));
      const row = rows[r];
      children.push(
        <div
          key={keys[r]}
          ref={observeRow}
          data-row-key={keys[r]}
          data-image-height={row.height}
          className="flex items-start"
          style={{ columnGap: gap }}
        >
          {Array.from({ length: row.count }, (_, k) => renderTile(row.start + k, row.height))}
        </div>,
      );
      prev = r;
    }
    if (prev < rows.length - 1) children.push(spacer(prev + 1, rows.length - 1));
    content = children;
  } else if (items.length > 0) {
    // Not measured yet (e.g. hidden): wrap at the target height instead of guessing a width.
    content = (
      <div className="flex flex-wrap items-start" style={{ gap }}>
        {items.slice(0, UNMEASURED_TILE_CAP).map((_, i) => renderTile(i, phone ? columnWidth : targetHeight))}
      </div>
    );
  }

  return (
    // Phone layout reaches the screen's edges past the page padding.
    <CompactGridContext.Provider value={phone}>
      <div
        ref={containerRef}
        role="list"
        className={`flex flex-col ${phone ? "-mx-page" : ""}`}
        style={{ rowGap: gap, overflowAnchor: "none" }}
        onFocus={(e) => setFocusKey(e.target.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocusKey(null);
        }}
      >
        {content}
      </div>
    </CompactGridContext.Provider>
  );
}
