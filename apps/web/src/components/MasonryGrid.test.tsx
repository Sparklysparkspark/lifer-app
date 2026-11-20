// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MasonryGrid from "./MasonryGrid";
import { justifyRows, rowTops, scrollShiftAbove, visibleRows, type JustifiedRow } from "./justifyRows";

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

describe("rowTops and visibleRows", () => {
  const heights = [100, 100, 100, 100, 100];
  const tops = rowTops(heights, 10);

  it("stacks rows with the gap between them", () => {
    expect(tops).toEqual([0, 110, 220, 330, 440]);
  });

  it("finds the rows overlapping the view, including ones cut by its edges", () => {
    expect(visibleRows(tops, heights, 150, 300)).toEqual([1, 2]);
    expect(visibleRows(tops, heights, 0, 100)).toEqual([0, 0]);
    // The gap between rows 0 and 1 overlaps neither.
    expect(visibleRows(tops, heights, 100, 110)).toEqual([1, 0]);
  });

  it("returns an empty range past either end", () => {
    const [first, last] = visibleRows(tops, heights, 1000, 2000);
    expect(first).toBeGreaterThan(last);
    expect(visibleRows(tops, heights, -500, -100)[1]).toBe(-1);
    expect(visibleRows([], [], 0, 100)).toEqual([0, -1]);
  });
});

describe("scrollShiftAbove", () => {
  const tops = [0, 110, 220, 330];
  const before = [100, 100, 100, 100];

  it("adds up the change of rows entirely above the view", () => {
    // Rows 0 and 1 end above 250; row 2 straddles it.
    expect(scrollShiftAbove(tops, before, [130, 90, 300, 100], 250)).toBe(20);
  });

  it("ignores rows the view's top edge cuts or that sit below it", () => {
    expect(scrollShiftAbove(tops, before, [100, 100, 500, 500], 250)).toBe(0);
    expect(scrollShiftAbove(tops, before, [500, 100, 100, 100], 50)).toBe(0);
  });

  it("counts a row ending exactly at the top edge as above it", () => {
    expect(scrollShiftAbove(tops, before, [140, 100, 100, 100], 100)).toBe(40);
  });
});

// Reports a container width, as the browser would once the grid is laid out; `resize` changes it.
function stubWidth(width: number) {
  const observers = new Set<{ cb: ResizeObserverCallback; el: Element }>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observers.add({ cb: this.cb, el });
        this.cb([{ contentRect: { width }, target: el } as unknown as ResizeObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return (next: number) =>
    act(() => {
      for (const { cb, el } of observers) {
        cb([{ contentRect: { width: next }, target: el } as unknown as ResizeObserverEntry], {} as never);
      }
    });
}

function manyItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i}`, ratio: i % 3 === 0 ? 0.75 : 1.5 }));
}

function renderMany(count: number) {
  const items = manyItems(count);
  return render(
    <MasonryGrid
      items={items}
      columnWidth={200}
      keyFor={(i) => i.id}
      aspectRatioFor={(i) => i.ratio}
      renderItem={(i) => <div data-id={i.id} />}
    />,
  );
}

// Moves the page as if scrolled: the grid's top goes above the screen by `y`.
function scrollGridTo(container: HTMLElement, y: number) {
  const list = container.querySelector<HTMLElement>("[role=list]")!;
  list.getBoundingClientRect = () => ({ top: -y, width: 1000, height: 0 }) as DOMRect;
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
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

describe("MasonryGrid windowing", () => {
  it("mounts only the rows near the screen and keeps the full height in spacers", () => {
    stubWidth(1000);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 0));
    const { container } = renderMany(20_000);
    const tiles = container.querySelectorAll("[role=listitem]");
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(200);
    expect(tiles[0].getAttribute("aria-posinset")).toBe("1");
    expect(tiles[0].getAttribute("aria-setsize")).toBe("20000");
    // One spacer below stands in for every row not mounted.
    const spacers = container.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(spacers).toHaveLength(1);
    expect(parseFloat(spacers[0].style.height)).toBeGreaterThan(100_000);
  });

  it("moves the window with the scroll position", () => {
    stubWidth(1000);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 0));
    const { container } = renderMany(20_000);
    scrollGridTo(container, 300_000);
    const tiles = container.querySelectorAll("[role=listitem]");
    const first = Number(tiles[0].getAttribute("aria-posinset"));
    expect(first).toBeGreaterThan(5_000);
    expect(tiles.length).toBeLessThan(200);
    // Spacers above and below.
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(2);
  });

  it("lays out the same tiles at the same widths after a resize and back", () => {
    const resize = stubWidth(1000);
    const { container } = renderMany(5_000);
    const snapshot = () =>
      [...container.querySelectorAll<HTMLElement>("[role=listitem]")].map(
        (el) => `${el.getAttribute("aria-posinset")}:${el.style.width}`,
      );
    const before = snapshot();
    resize(600);
    expect(snapshot()).not.toEqual(before);
    resize(1000);
    expect(snapshot()).toEqual(before);
  });
});
