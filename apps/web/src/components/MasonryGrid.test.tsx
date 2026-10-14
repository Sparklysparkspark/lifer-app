// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MasonryGrid from "./MasonryGrid";
import { justifyRows, type JustifiedRow } from "./justifyRows";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GAP = 8;
const WIDTH = 1000;

// Rendered width of a row: its items at the row height plus the gaps between them.
function rowWidth(row: JustifiedRow, ratios: number[], gap = GAP) {
  const ratioSum = ratios.slice(row.start, row.start + row.count).reduce((a, b) => a + b, 0);
  return ratioSum * row.height + gap * (row.count - 1);
}

describe("justifyRows", () => {
  const ratios = [1.5, 0.67, 1.5, 1, 1.33, 0.75, 1.5, 1.5, 2, 0.8, 1.5];

  it("fills every full row to the container width within 1px", () => {
    const rows = justifyRows(ratios, WIDTH, 200, GAP);
    for (const row of rows.filter((r) => !r.partial)) {
      expect(Math.abs(rowWidth(row, ratios) - WIDTH)).toBeLessThan(1);
    }
  });

  it("places every item exactly once, in order", () => {
    const rows = justifyRows(ratios, WIDTH, 200, GAP);
    let next = 0;
    for (const row of rows) {
      expect(row.start).toBe(next);
      next += row.count;
    }
    expect(next).toBe(ratios.length);
  });

  it("leaves the last row at the target height without stretching it", () => {
    const rows = justifyRows([1.5, 1.5, 1.5, 1.5, 1.5], WIDTH, 200, GAP);
    const last = rows[rows.length - 1];
    expect(last.partial).toBe(true);
    expect(last.height).toBe(200);
    expect(rowWidth(last, [1.5, 1.5, 1.5, 1.5, 1.5])).toBeLessThan(WIDTH);
  });

  it("gives a panorama wider than the container its own row, scaled down", () => {
    const panoRatios = [1.5, 1.5, 8, 1.5];
    const rows = justifyRows(panoRatios, WIDTH, 200, GAP);
    const pano = rows.find((r) => r.start === 2)!;
    expect(pano.count).toBe(1);
    expect(pano.height).toBeCloseTo(WIDTH / 8);
    expect(pano.partial).toBe(false);
  });

  it("keeps gaps equal: rows differ only in height, never in spacing", () => {
    // Widths are ratio * height and the gap is added once between neighbors, so a row fills the
    // width only if every gap is exactly GAP.
    const rows = justifyRows(ratios, WIDTH, 200, GAP);
    for (const row of rows.filter((r) => !r.partial)) {
      const imagesWidth = rowWidth(row, ratios, 0);
      expect(WIDTH - imagesWidth).toBeCloseTo(GAP * (row.count - 1));
    }
  });

  it("returns nothing for no items", () => {
    expect(justifyRows([], WIDTH, 200, GAP)).toEqual([]);
  });
});

// Reports a fixed container width, as the browser would once the grid is laid out.
function stubWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
}

describe("MasonryGrid", () => {
  it("sizes tiles from the row layout and passes each item's own ratio", () => {
    stubWidth(1000);
    const seen: number[] = [];
    const { container } = render(
      <MasonryGrid
        items={[
          { id: "a", ratio: 1.5 },
          { id: "b", ratio: 0.75 },
        ]}
        columnWidth={200}
        keyFor={(i) => i.id}
        aspectRatioFor={(i) => i.ratio}
        renderItem={(_, ratio) => {
          seen.push(ratio);
          return <div />;
        }}
      />,
    );
    const tiles = container.querySelectorAll<HTMLElement>("[style*='width']");
    // Partial row at the target height (200 * 0.66).
    expect(parseFloat(tiles[0].style.width)).toBeCloseTo(1.5 * 132);
    expect(parseFloat(tiles[1].style.width)).toBeCloseTo(0.75 * 132);
    expect(seen.slice(-2)).toEqual([1.5, 0.75]);
  });
});
