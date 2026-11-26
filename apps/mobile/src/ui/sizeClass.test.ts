import { describe, expect, it } from "vitest";
import { CARD_MIN, columnsFor, sizeClassOf } from "./sizeClass";

// Fold cover, iPhone, iPhone Duo upright, iPhone Duo open, iPad landscape.
const WIDTHS = [344, 390, 669, 951, 1366];

describe("size classes", () => {
  it("compact under 600, medium 600 to 839, expanded from 840", () => {
    expect(WIDTHS.map(sizeClassOf)).toEqual(["compact", "compact", "medium", "expanded", "expanded"]);
    expect([599, 600, 839, 840].map(sizeClassOf)).toEqual(["compact", "medium", "medium", "expanded"]);
  });

  it("cards come from a minimum width: 2 and 3 across on phones, more on wide windows", () => {
    expect(WIDTHS.map((w) => columnsFor(w, CARD_MIN.large))).toEqual([2, 2, 4, 5, 8]);
    expect(WIDTHS.map((w) => columnsFor(w, CARD_MIN.small))).toEqual([3, 3, 6, 8, 12]);
  });

  it("a card is never narrower than its minimum and never stretched to 1.5 times past it on these windows", () => {
    for (const w of WIDTHS)
      for (const min of [CARD_MIN.large, CARD_MIN.small]) {
        const n = columnsFor(w, min);
        const card = (w - 32 - 12 * (n - 1)) / n;
        expect(card).toBeGreaterThanOrEqual(min);
        expect(card).toBeLessThan(min * 1.5);
      }
  });

  it("a window narrower than one card still shows one column", () => {
    expect(columnsFor(100, CARD_MIN.large)).toBe(1);
  });
});
