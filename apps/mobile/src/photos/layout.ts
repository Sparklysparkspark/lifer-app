// The Gallery grid as rows of known height, so a 60,000 photo library scrolls without measuring:
// month headings and rows of squares (or of photos kept in their shape), with every row's offset known up front.
import type { GridPhoto } from "../store/library";

export type GridRow =
  { type: "heading"; key: string; monthKey: string } | { type: "photos"; key: string; ids: string[]; widths: number[] };

export interface Grid {
  rows: GridRow[];
  heights: number[];
  offsets: number[];
  /** First row of each month, for the scrubber. */
  months: { monthKey: string; row: number }[];
  /** Indices of the heading rows, which stick to the top while their month scrolls. */
  headings: number[];
  /** Index in the photo list of each row's first photo. */
  firstIndex: number[];
}

export type Shaped = GridPhoto & { width?: number | null; height?: number | null; name?: string | null };

export const monthOf = (takenAt: string | null): string =>
  takenAt && /^\d{4}-\d{2}/.test(takenAt) ? takenAt.slice(0, 7) : "undated";

interface Layout {
  /** Total width of the grid. */
  width: number;
  headingHeight: number;
  withHeadings: boolean;
}

/**
 * Squares, `columns` across.
 * Or, with `aspect`, rows of photos that keep their shape: each row is filled to the full width at about `rowHeight`.
 */
export function buildGrid(photos: Shaped[], layout: Layout, mode: { columns: number } | { aspect: number }): Grid {
  const rows: GridRow[] = [];
  const heights: number[] = [];
  const months: Grid["months"] = [];
  const headings: number[] = [];
  const firstIndex: number[] = [];
  let month = "";
  let current: Shaped[] = [];
  let at = 0;
  const square = "columns" in mode;
  const cell = square ? Math.floor(layout.width / mode.columns) : 0;

  const flush = (last: boolean) => {
    if (!current.length) return;
    let widths: number[];
    let height: number;
    if (square) {
      widths = current.map(() => cell);
      height = cell;
    } else {
      const ratios = current.map((p) => (p.width && p.height ? p.width / p.height : 1.5));
      const sum = ratios.reduce((a, b) => a + b, 0);
      // A short last row keeps the target height instead of stretching to fill.
      height = last && sum * mode.aspect < layout.width ? mode.aspect : layout.width / sum;
      widths = ratios.map((r) => r * height);
    }
    firstIndex[rows.length] = at;
    at += current.length;
    rows.push({ type: "photos", key: `r${rows.length}`, ids: current.map((p) => p.photoId), widths });
    heights.push(Math.round(height));
    current = [];
  };
  const full = () => {
    if (square) return current.length === mode.columns;
    const sum = current.reduce((a, p) => a + (p.width && p.height ? p.width / p.height : 1.5), 0);
    return sum * mode.aspect >= layout.width;
  };

  for (const p of photos) {
    const m = monthOf(p.takenAt);
    if (!layout.withHeadings && m !== month) {
      // A continuous grid has no headings; the scrubber still names the month (the row it starts in).
      month = m;
      months.push({ monthKey: m, row: rows.length });
    }
    if (layout.withHeadings && m !== month) {
      flush(true);
      month = m;
      months.push({ monthKey: m, row: rows.length });
      headings.push(rows.length);
      firstIndex[rows.length] = at;
      rows.push({ type: "heading", key: `h${m}`, monthKey: m });
      heights.push(layout.headingHeight);
    }
    current.push(p);
    if (full()) flush(false);
  }
  flush(true);

  const offsets: number[] = [];
  let y = 0;
  for (const h of heights) {
    offsets.push(y);
    y += h;
  }
  return { rows, heights, offsets, months, headings, firstIndex };
}

/** The month under a scrubber position (0 top, 1 bottom). */
export function monthAt(grid: Grid, fraction: number): { monthKey: string; row: number } | null {
  if (!grid.months.length) return null;
  const total = grid.offsets.length ? grid.offsets[grid.offsets.length - 1] + grid.heights[grid.heights.length - 1] : 0;
  const y = Math.max(0, Math.min(1, fraction)) * total;
  let found = grid.months[0];
  for (const m of grid.months) if (grid.offsets[m.row] <= y) found = m;
  return found;
}

/** The row holding the photo at `index`, or -1. */
export function rowOfPhoto(grid: Grid, index: number): number {
  let lo = 0;
  let hi = grid.rows.length - 1;
  // Rows are in photo order, so the last row starting at or before the index holds it (headings share their month's first index).
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (grid.firstIndex[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  const r = grid.rows[lo];
  if (!r) return -1;
  return r.type === "photos" ? lo : grid.rows[lo + 1]?.type === "photos" ? lo + 1 : -1;
}
