// Window size classes (the Android thresholds, used on both platforms) and grid columns from width.
// Pure, so it is unit tested without a device; useSizeClass reads the window.

export type SizeClass = "compact" | "medium" | "expanded";

export const sizeClassOf = (width: number): SizeClass =>
  width < 600 ? "compact" : width < 840 ? "medium" : "expanded";

/** Under this height a window is short (a phone in landscape): no tall hero, no two panes. */
export const SHORT_HEIGHT = 480;

/** Grids sit 16 pt in from each edge with 12 pt between cards. */
export const GRID_PAD = 16;
export const GRID_GAP = 12;

/** The narrowest a card may be: 2 and 3 across on a phone (344 pt cover screens too), 4 and 6 at 669 pt. */
export const CARD_MIN = { large: 150, small: 96 } as const;

/** As many columns as fit at the minimum card width, never fewer than one; cards then share the rest. */
export const columnsFor = (width: number, min: number): number =>
  Math.max(1, Math.floor((width - 2 * GRID_PAD + GRID_GAP) / (min + GRID_GAP)));
