import { describe, expect, it } from "vitest";
import { buildGrid, monthAt, monthOf, rowOfPhoto } from "./layout";

const photo = (id: string, takenAt: string | null, width: number | null = 100, height: number | null = 100) => ({
  photoId: id,
  takenAt,
  width,
  height,
});
const L = { width: 300, headingHeight: 40, withHeadings: true };

describe("monthOf", () => {
  it("is the year and month, or undated", () => {
    expect(monthOf("2026-05-12T10:00:00Z")).toBe("2026-05");
    expect(monthOf(null)).toBe("undated");
  });
});

describe("buildGrid squares", () => {
  const photos = [
    photo("a", "2026-05-02"),
    photo("b", "2026-05-01"),
    photo("c", "2026-05-01"),
    photo("d", "2026-05-01"),
    photo("e", "2026-04-09"),
  ];
  const grid = buildGrid(photos, L, { columns: 3 });
  it("breaks rows by month and column count, with a heading before each month", () => {
    expect(grid.rows.map((r) => (r.type === "heading" ? `h:${r.monthKey}` : r.ids.join("")))).toEqual([
      "h:2026-05",
      "abc",
      "d",
      "h:2026-04",
      "e",
    ]);
    expect(grid.heights).toEqual([40, 100, 100, 40, 100]);
    expect(grid.offsets).toEqual([0, 40, 140, 240, 280]);
    expect(grid.headings).toEqual([0, 3]);
  });
  it("knows the first photo of each row, for opening the viewer at the right one", () => {
    expect(grid.firstIndex[1]).toBe(0);
    expect(grid.firstIndex[2]).toBe(3);
    expect(grid.firstIndex[4]).toBe(4);
  });
  it("finds the month under a scrubber position", () => {
    expect(monthAt(grid, 0)?.monthKey).toBe("2026-05");
    expect(monthAt(grid, 0.99)?.monthKey).toBe("2026-04");
  });
});

describe("buildGrid aspect ratio rows", () => {
  it("fills each row to the full width and keeps every photo's shape", () => {
    const photos = [
      photo("a", "2026-05-02", 200, 100),
      photo("b", "2026-05-02", 100, 100),
      photo("c", "2026-05-02", 100, 200),
      photo("d", "2026-05-02", 100, 100),
    ];
    const grid = buildGrid(photos, { ...L, withHeadings: false }, { aspect: 120 });
    const first = grid.rows[0];
    expect(first.type).toBe("photos");
    if (first.type === "photos") expect(Math.round(first.widths.reduce((a, b) => a + b, 0))).toBe(300);
  });
});

describe("continuous grid", () => {
  const photos = [
    photo("a", "2026-05-02"),
    photo("b", "2026-05-01"),
    photo("c", "2026-04-01"),
    photo("d", "2026-04-01"),
    photo("e", "2026-04-01"),
  ];
  const grid = buildGrid(photos, { ...L, withHeadings: false }, { columns: 2 });
  it("has no headings, one seamless run of rows, and still knows its months", () => {
    expect(grid.rows.map((r) => (r.type === "photos" ? r.ids.join("") : "h"))).toEqual(["ab", "cd", "e"]);
    expect(grid.headings).toEqual([]);
    expect(grid.months).toEqual([
      { monthKey: "2026-05", row: 0 },
      { monthKey: "2026-04", row: 1 },
    ]);
  });
  it("finds the row holding a photo, with or without headings", () => {
    expect(rowOfPhoto(grid, 4)).toBe(2);
    const dated = buildGrid(photos, L, { columns: 2 });
    expect(dated.rows[rowOfPhoto(dated, 2)]).toMatchObject({ type: "photos", ids: ["c", "d"] });
  });
});
