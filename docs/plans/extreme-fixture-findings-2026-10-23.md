# Extreme fixture findings (2026-10-23)

Found by the Q-05 review on the extreme, sparse and empty seeds (`npm run seed:extreme`). Q-06 records
these in `e2e/known-failures.json`; the U-packages fix them. Rule ids are from `ux-rules.md`.

## Collection (extreme)
- A 300-character state chip wraps the "Areas in" row to three lines (S8, L4). (fixed 2026-10-23)
- A 300-character common name shrinks to tiny text and overflows its card (S8, L6). (fixed 2026-10-23)
- "4,500 of 4,800 photographed" against a 5,000-species checklist with 300 hidden: check the counts
  add up (U1).

## Trips (extreme)
- A 300-character trip name shrinks and overflows its card (S8, L6). (fixed 2026-10-23)
- Undated trips take a long range from their photos, cut off with "..." (S8).
- Date formats differ between cards: "January 2015 to March 2019" next to "Jan 8 to 13, 2015" (C3).
- Toolbar order: primary "Start a trip" comes first, while Albums puts "New album" last; the info
  button sits left of both (C3, L5). (order fixed 2026-10-23; the info glyph size is still smaller than icon buttons)

## Albums (extreme)
- A long name ends in "..." with no way to read the rest (S8), and differs from Trips, which shrinks
  the text (C3). (fixed 2026-10-23)

## Gallery (extreme)
- The header says "59,183 photos" (60,000 minus 600 videos, 150 hidden, 67 trashed). Either videos
  are left out by default or "photos" is the wrong word once videos exist (U1, W9). (fixed 2026-10-23: videos are
  left out by default, so the count was true; the wording now follows the Media filter)

## Stats
- "Total photographed 4500" has no thousands separator; Collection shows "4,500" (S7, U1). (fixed 2026-10-23)
- "Top camera" wraps in large type inside a small tile (S8). (fixed 2026-10-23)
- The dropdowns ("All keepers", "Overall", "New lifers") look like native selects and differ in
  height from the buttons beside them (C1, L4). All seeds.
- Sparse: the "By month" axis runs to 4 when the largest value is 1 (S5). (fixed 2026-10-23)

## Page titles
- (fixed: the desktop toolbar shows each page name, which the maintainer confirmed on 2026-10-25 is the title they want; no change needed)
- Albums, Trips, Stats and Gallery show no page title; Collection does (C8). Approved 2026-10-25 for all
  main pages. Checked 2026-10-25: all five pages already render an h1 through `PageHeader`, but a
  top-level page hides it visually (`sr-only`; the nav marks the place), so it was left open: no visible
  title on any of them.

## Empty seed
- Stats still offers "Export CSV" and the keeper filter with nothing to export (A1, A4). (fixed 2026-10-23)
- The Stats empty state has no action button, unlike Gallery's "Import photos" (S6). (fixed 2026-10-23)
- Gallery's View, Filters and "..." buttons stay visible with 0 photos (A1). (fixed 2026-10-23)

## Not yet swept
Light and dark, the smallest and a 27-inch window, and Settings on these seeds (Q-08, Q-12).
