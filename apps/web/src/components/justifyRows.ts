export type JustifiedRow = {
  /** Index of the row's first item. */
  start: number;
  count: number;
  /** Image height in px; each item's width is its ratio times this. */
  height: number;
  /** The last, unfilled row: kept at the target height and left-aligned. */
  partial: boolean;
};

/** Packs items into rows that fill `containerWidth` exactly. A row closes once its natural width
 *  at `targetHeight` reaches the container, with or without the item that crossed the edge,
 *  whichever leaves the row height nearer the target. O(n). */
export function justifyRows(
  ratios: readonly number[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
): JustifiedRow[] {
  const rows: JustifiedRow[] = [];
  // Height that makes items [start, start + count) with these summed ratios fill the width.
  const fitHeight = (count: number, ratioSum: number) => (containerWidth - gap * (count - 1)) / ratioSum;
  let start = 0;
  let ratioSum = 0;
  for (let i = 0; i < ratios.length; i++) {
    const ratio = ratios[i];
    const count = i - start + 1;
    ratioSum += ratio;
    if (ratioSum * targetHeight + gap * (count - 1) < containerWidth) continue;
    const heightWith = fitHeight(count, ratioSum);
    const heightWithout = count > 1 ? fitHeight(count - 1, ratioSum - ratio) : Infinity;
    // Compare as ratios: stretching 1.2x reads as far off as shrinking to 1/1.2.
    if (heightWithout / targetHeight < targetHeight / heightWith) {
      rows.push({ start, count: count - 1, height: heightWithout, partial: false });
      start = i;
      ratioSum = ratio;
      // A panorama wider than the container takes a row alone, scaled down.
      if (ratio * targetHeight < containerWidth) continue;
      rows.push({ start: i, count: 1, height: containerWidth / ratio, partial: false });
    } else {
      rows.push({ start, count, height: heightWith, partial: false });
    }
    start = i + 1;
    ratioSum = 0;
  }
  if (start < ratios.length) {
    rows.push({ start, count: ratios.length - start, height: targetHeight, partial: true });
  }
  return rows;
}

/** The gap between photos for a Size slider value: tight at the smallest sizes, where a wide gap
 *  would dominate the thumbnails, growing to 8px from the middle sizes up. */
export function gridGapFor(sizePx: number): number {
  return Math.min(8, Math.max(2, Math.round((sizePx - 100) / 20)));
}

/** Each row's top, given every row's full height (image plus caption) and the gap between rows. */
export function rowTops(heights: readonly number[], gap: number): number[] {
  const tops = new Array<number>(heights.length);
  let y = 0;
  for (let r = 0; r < heights.length; r++) {
    tops[r] = y;
    y += heights[r] + gap;
  }
  return tops;
}

/** First and last row overlapping [viewTop, viewBottom), both in grid coordinates. first > last
 *  when no row does. Binary search, so it stays cheap for tens of thousands of rows. */
export function visibleRows(
  tops: readonly number[],
  heights: readonly number[],
  viewTop: number,
  viewBottom: number,
): [number, number] {
  let lo = 0;
  let hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] > viewTop) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;
  hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] < viewBottom) lo = mid + 1;
    else hi = mid;
  }
  return [first, lo - 1];
}

/** How far content moved down when rows changed height from `prevHeights` to `heights`, counting
 *  only rows that lay entirely above `viewTop` (grid coordinates, from the previous layout's
 *  `tops`): scrolling by it keeps what's on screen still. Rows below the top edge just push the
 *  content under them, as expected. */
export function scrollShiftAbove(
  tops: readonly number[],
  prevHeights: readonly number[],
  heights: readonly number[],
  viewTop: number,
): number {
  let shift = 0;
  for (let r = 0; r < tops.length && tops[r] + prevHeights[r] <= viewTop; r++) shift += heights[r] - prevHeights[r];
  return shift;
}
