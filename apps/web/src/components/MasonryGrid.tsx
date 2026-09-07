import { useEffect, useRef, useState, type ReactNode } from "react";

// A real CSS Grid masonry (grid-auto-flow: dense, each item's height translated into a
// grid-row span in small fixed units) rather than JS-computed bin packing — the previous
// approach packed each item into ONE whole flex column, which had no way to let a single item
// occupy TWO columns at once (a panorama, ~1.8:1 or wider) while the rest of the grid kept
// packing normally around it; a spanning item and independent per-column flex containers are
// fundamentally incompatible. CSS Grid's own dense auto-placement algorithm is the standard
// solution for exactly this (a well-known technique, not a custom invention here): give every
// item a `grid-row: span N` sized to its own rendered height, let a wide item additionally take
// `grid-column: span 2`, and the browser's own placement engine finds a slot for it and back-
// fills the gaps around it — no manual bin-packing code needed at all, which is also why the
// previous column-count/ResizeObserver bookkeeping is gone: `repeat(auto-fill, minmax(...))`
// recomputes the column count on its own as the container resizes.
const FALLBACK_ASPECT_RATIO = 4 / 3;
// A panorama-shaped photo (this ratio or wider) spans two grid columns instead of one — chosen
// as a real "this is unmistakably a pano, not just a wide landscape shot" cutoff (a normal 3:2
// landscape is 1.5; this sits meaningfully above that).
const WIDE_ASPECT_RATIO_THRESHOLD = 1.8;
// A portrait shot taller than this ratio gets visually cropped to it instead of rendering at
// its full height. Uncropped, a genuinely tall portrait next to ordinary landscape shots forces
// a much bigger cell than its neighbors, and there's often no similarly tall item queued nearby
// to fill the gap this leaves underneath — a structural side effect of true variable-aspect
// masonry, not something denser packing alone can fix. Set below a normal 3:2 landscape's
// reciprocal so only genuinely portrait-oriented shots are affected, not mild ones. The full,
// uncropped photo is still shown in the lightbox; this only affects the grid thumbnail.
const MIN_ASPECT_RATIO = 0.75;
// The unit grid-auto-rows advances by. Kept at 1px (rather than a coarser unit) because the
// vertical gap below each item is applied as real padding on the item itself (see paddingBottom
// below), not via the grid's own row-gap — a coarser unit would round each item's row-span up to
// its own multiple, which reads as extra vertical whitespace with nothing to visually absorb it
// once a caption isn't rendered underneath (see extraHeightPx). column-gap has no equivalent
// rounding at all (CSS Grid's auto-fill columns aren't quantized), so this is what keeps
// vertical spacing matching horizontal instead of drifting larger.
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
  /** px gap, both between columns and between stacked items within a column. */
  gap?: number;
  /** Extra height EVERY item's row-span estimate should budget for, beyond the image itself —
   *  a caption or star rating rendered below the photo (see GalleryPage's own toggles). These
   *  render at the same fixed height no matter which item it is, so one flat number for the
   *  whole grid is correct here. Without this the estimate only ever covers the image, so
   *  turning a label on pushes the item taller than its reserved row-span and it overlaps
   *  whatever's below it. */
  extraHeightPx?: number;
  /** Same idea as extraHeightPx, but for content whose height genuinely varies PER ITEM (a
   *  camera-info line that wraps to a second line for some photos and not others, depending on
   *  how long that specific photo's camera+lens string is) — applying extraHeightPx's one fixed
   *  number to every item would either overlap the items that wrap or waste vertical space on
   *  every item that doesn't. Added on top of extraHeightPx, not in place of it. The real
   *  rendered column width (which the caller has no other way to know — it depends on the
   *  container's own measured width, not just the nominal columnWidth prop) is passed as the
   *  second argument so the caller can estimate whether ITS text will actually wrap at that
   *  width. */
  extraHeightPxFor?: (item: T, columnWidthPx: number) => number;
  /** Second argument is the aspect ratio (clamped per MIN_ASPECT_RATIO) this item should
   *  actually render at — pass it through to the image so a cropped layout estimate and the
   *  cropped visual both agree, or overlap/gaps come back in a different form. */
  renderItem: (item: T, aspectRatio: number) => ReactNode;
  keyFor: (item: T) => string;
  /** Width/height ratio (e.g. 1.5 for a 3:2 landscape shot) this item will render at, used to
   *  estimate its height for packing, and to decide whether it's wide enough to span two grid
   *  columns (a panorama). Return null/undefined for an item whose real dimensions aren't known
   *  yet — it falls back to FALLBACK_ASPECT_RATIO (never spans two columns, since a genuinely
   *  wide photo is exactly the case this needs real data for). */
  aspectRatioFor?: (item: T) => number | null | undefined;
}) {
  // `minmax(columnWidth, 1fr)` makes CSS stretch each column past `columnWidth` to fill
  // whatever's left over once as many columns as fit are placed — often by a lot, since the
  // container width rarely divides evenly by columnWidth + gap. Estimating each item's height
  // from the nominal columnWidth instead of that real, wider rendered column width used to
  // undershoot the row-span the item actually needs, so the next row's items would slide up
  // into it. Measuring the container and replicating auto-fill's own column math here keeps
  // the height estimate matched to what the browser actually renders, at any zoom size.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const numColumns = containerWidth > 0 ? Math.max(1, Math.floor((containerWidth + gap) / (columnWidth + gap))) : 1;
  const realColumnWidth = containerWidth > 0 ? (containerWidth - gap * (numColumns - 1)) / numColumns : columnWidth;

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${columnWidth}px, 1fr))`,
        gridAutoRows: `${ROW_UNIT_PX}px`,
        gridAutoFlow: "dense",
        columnGap: gap,
        rowGap: 0,
      }}
    >
      {items.map((item) => {
        const naturalRatio = aspectRatioFor?.(item) || FALLBACK_ASPECT_RATIO;
        const isWide = naturalRatio >= WIDE_ASPECT_RATIO_THRESHOLD;
        // Only the portrait (too-tall) side is clamped — a wide/pano shot already gets its own
        // extra column instead of being squeezed, so its real ratio is left alone.
        const layoutRatio = isWide ? naturalRatio : Math.max(naturalRatio, MIN_ASPECT_RATIO);
        // A 2-column-span item renders at roughly double the single-column width (plus the one
        // gap between the two tracks it now covers) — its height estimate has to scale with
        // that wider effective width too, or a spanned pano's row-span would be sized as if it
        // were still rendering at the single-column width, leaving a large gap underneath it.
        const renderedWidth = isWide ? realColumnWidth * 2 + gap : realColumnWidth;
        const estimatedHeight =
          renderedWidth / layoutRatio + extraHeightPx + (extraHeightPxFor?.(item, realColumnWidth) ?? 0);
        // Row-gap is 0 on the grid itself (see above) — the visible vertical gap comes from this
        // item's own paddingBottom instead, a real, exact value rather than something derived
        // from how many whole ROW_UNIT_PX tracks happen to fit. The row-span still has to book
        // that padding's height too, or the padding would get clipped by the next row starting.
        const rowSpan = Math.max(1, Math.ceil((estimatedHeight + gap) / ROW_UNIT_PX));
        return (
          // min-w-0: a grid item's default min-width is its content's intrinsic width, not 0 —
          // without this, a long unbroken caption (e.g. the camera/lens info line some items
          // show) can't ever be shrunk, forcing this track wider than intended (same reasoning
          // the previous flex-based version's own comment gave for its column containers).
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
