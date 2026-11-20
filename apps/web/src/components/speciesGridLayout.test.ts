import { describe, expect, it } from "vitest";
import type { CollectionItem } from "@lifer/shared";
import {
  autoFillColumns,
  blockTops,
  buildBlocks,
  fluidSizeStepIndex,
  fluidSizeSteps,
  gapPxFor,
  type SpeciesGroup,
} from "./speciesGridLayout";

const species = (id: string) => ({ speciesId: id }) as CollectionItem;
const group = (key: string, count: number): SpeciesGroup => ({
  key,
  label: key,
  items: Array.from({ length: count }, (_, i) => species(`${key}-${i}`)),
});

const base = {
  pinnedKeys: new Set(["__collected__"]),
  collapsed: new Set<string>(),
  packSmallGroups: true,
  width: 1000,
  cardMinWidth: 160,
  gap: 5,
  headingWidth: () => 100,
};

describe("autoFillColumns", () => {
  it("fits as many tracks as CSS auto-fill would", () => {
    // 6 cards of 160 plus 5 gaps of 5 is 985 <= 1000; 7 would be 1150.
    expect(autoFillColumns(1000, 160, 5)).toBe(6);
    expect(autoFillColumns(985, 160, 5)).toBe(6);
    expect(autoFillColumns(984, 160, 5)).toBe(5);
    expect(autoFillColumns(2560, 120, 4)).toBe(20);
  });

  it("never drops below one column", () => {
    expect(autoFillColumns(100, 160, 5)).toBe(1);
  });
});

describe("fluidSizeSteps", () => {
  const columnsAt = (width: number, size: number) => autoFillColumns(width, size, gapPxFor(size));

  it("gives one stop per column count, each the largest size with that count", () => {
    // 250px: two cards up to 123px wide (with its 4px gap), then one.
    expect(fluidSizeSteps(250, 120, 320)).toEqual([123, 320]);
    for (const width of [250, 777, 1280, 2560]) {
      const steps = fluidSizeSteps(width, 120, 320);
      const counts = steps.map((size) => columnsAt(width, size));
      // Fewer columns (bigger cards) to the right, never the same count twice.
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1]);
      for (const size of steps) if (size < 320) expect(columnsAt(width, size + 1)).toBeLessThan(columnsAt(width, size));
      // Every size the old slider could reach looks like one of the stops.
      for (let size = 120; size <= 320; size++) expect(counts).toContain(columnsAt(width, size));
    }
  });

  it("has a single stop when every size gives the same columns", () => {
    expect(fluidSizeSteps(100, 120, 320)).toEqual([320]);
  });

  it("finds the stop showing a stored size", () => {
    expect(fluidSizeStepIndex([123, 320], 120)).toBe(0);
    expect(fluidSizeStepIndex([123, 320], 123)).toBe(0);
    expect(fluidSizeStepIndex([123, 320], 160)).toBe(1);
    expect(fluidSizeStepIndex([123, 320], 400)).toBe(1);
  });
});

describe("buildBlocks", () => {
  it("splits an ungrouped list into full-width rows of stretched cards", () => {
    const blocks = buildBlocks({ ...base, groups: [group("", 3000)], ungrouped: true });
    expect(blocks).toHaveLength(500);
    const row = blocks[0];
    expect(row.kind === "row" && row.columns).toBe(6);
    expect(row.kind === "row" && row.fluid).toBe(true);
    expect(row.kind === "row" && row.cardWidth).toBeCloseTo((1000 - 25) / 6);
    expect(blocks.at(-1)!.kind === "row" && blocks.at(-1)!.key).toBe("r::-2994");
  });

  it("puts pinned groups first and keeps every heading in order", () => {
    const groups = [group("Ducks", 40), group("Owls", 3), group("Grebes", 2), group("__collected__", 7)];
    const blocks = buildBlocks({ ...base, groups, ungrouped: false });
    const order = blocks.flatMap((b) =>
      b.kind === "heading" ? [b.group.key] : b.kind === "packed" ? b.groups.map((g) => g.group.key) : [],
    );
    expect(order).toEqual(["__collected__", "Ducks", "Owls", "Grebes"]);
    // The pinned copy and the normal group have rows of their own keys.
    expect(blocks[1].key).toBe("r:__collected__:__collected__-0");
    // Small groups share one packed line; the big one takes the full width.
    const packed = blocks.filter((b) => b.kind === "packed");
    expect(packed).toHaveLength(1);
  });

  it("wraps packed groups into a new line when the next doesn't fit", () => {
    // Each 4-card cluster is 4 * 160 + 3 * 5 = 655 wide, so only one fits per 1000px line.
    const groups = [group("A", 4), group("B", 4), group("C", 4)];
    const blocks = buildBlocks({ ...base, groups, ungrouped: false });
    expect(blocks.map((b) => b.kind)).toEqual(["packed", "packed", "packed"]);
    expect(blocks.map((b) => b.gapBefore)).toEqual([0, 24, 24]);
  });

  it("gives a one-card group its heading's width when the heading is wider", () => {
    const blocks = buildBlocks({ ...base, groups: [group("A", 1)], ungrouped: false, headingWidth: () => 300 });
    expect(blocks[0].kind === "packed" && blocks[0].groups[0].width).toBe(300);
  });

  it("shows a collapsed group as just its heading, packed beside others", () => {
    const groups = [group("A", 100), group("B", 100)];
    const blocks = buildBlocks({ ...base, groups, ungrouped: false, collapsed: new Set(["A", "B"]) });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === "packed" && blocks[0].groups.map((g) => g.collapsed)).toEqual([true, true]);
  });

  it("never packs tiers, but stacks each with its rows", () => {
    const groups = [group("rare", 2), group("common", 13)];
    const blocks = buildBlocks({ ...base, groups, ungrouped: false, packSmallGroups: false });
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "row", "heading", "row", "row", "row"]);
    expect(blocks.map((b) => b.gapBefore)).toEqual([0, 8, 24, 8, 5, 5]);
  });
});

describe("blockTops", () => {
  it("stacks blocks with the gap above each", () => {
    expect(blockTops([20, 100, 100], [0, 8, 5])).toEqual([0, 28, 133]);
  });
});
