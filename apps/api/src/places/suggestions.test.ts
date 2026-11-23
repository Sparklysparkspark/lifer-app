import { describe, expect, it } from "vitest";
import { anchorCell, clusterPoints, type PhotoPoint } from "./suggestions.js";
import { insideSpotSql, SPOT_OF_PHOTO } from "./spotArea.js";

// Metres to degrees near 50 N, close enough for building fixtures.
const north = (m: number) => m / 111_320;
const east = (m: number) => m / (111_320 * Math.cos((50 * Math.PI) / 180));
let n = 0;
const at = (dy: number, dx: number, day: string | null): PhotoPoint => ({
  id: `p${String(n++).padStart(6, "0")}`,
  lat: 50 + north(dy),
  lon: -120 + east(dx),
  day,
});

describe("clusterPoints", () => {
  const pond = [at(0, 0, "2026-05-01"), at(30, 20, "2026-05-01"), at(-20, 40, "2026-06-12"), at(10, -30, "2026-07-02")];

  it("suggests a spot visited on more than one day, with its centre, size and anchor", () => {
    const [s, ...rest] = clusterPoints(pond, []);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ count: 4, days: 3, radiusM: 50 });
    expect(s.cell).toBe(anchorCell(s.lat, s.lon));
  });

  it("gives the same answer whatever order the photos come in", () => {
    const many = [
      ...pond,
      ...Array.from({ length: 40 }, (_, i) => at(5000 + (i % 7) * 20, (i % 5) * 30, `2026-0${1 + (i % 3)}-01`)),
    ];
    expect(clusterPoints([...many].reverse(), [])).toEqual(clusterPoints(many, []));
  });

  it("needs three photos on two days", () => {
    expect(clusterPoints(pond.slice(0, 2), [])).toEqual([]);
    const oneDay = [at(0, 0, "2026-01-01"), at(10, 0, "2026-01-01"), at(20, 0, "2026-01-01")];
    expect(clusterPoints(oneDay, [])).toEqual([]);
    expect(clusterPoints([at(0, 0, null), at(10, 0, null), at(20, 0, null)], [])).toEqual([]);
  });

  it("leaves out photos a place already covers, and dismissed anchors", () => {
    expect(clusterPoints(pond, [{ lat: 50, lon: -120, radius_m: 25 }])).toEqual([]);
    const cell = clusterPoints(pond, [])[0].cell;
    expect(clusterPoints(pond, [], new Set([cell]))).toEqual([]);
  });

  it("doesn't suggest a 3 km trail as one place", () => {
    const trail = Array.from({ length: 40 }, (_, i) => at(i * 80, 0, `2026-0${1 + (i % 2)}-01`));
    expect(clusterPoints(trail, []).every((s) => s.count < 40 && s.radiusM <= 1000)).toBe(true);
  });
});

describe("spot containment SQL", () => {
  it("matches by distance within the radius, and filters only when asked", () => {
    expect(SPOT_OF_PHOTO).toContain("<= sp.radius_m");
    const params: unknown[] = [];
    const sql = insideSpotSql("s1", (v) => {
      params.push(v);
      return `$${params.length}`;
    });
    expect(sql).toContain("<= one.radius_m");
    expect(params).toEqual(["s1"]);
    expect(insideSpotSql(null, () => "$9")).toBe("");
  });
});
