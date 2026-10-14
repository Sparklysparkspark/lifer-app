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
