import { describe, expect, it } from "vitest";
import { clusterPoints, type PhotoPoint } from "./suggestions.js";

// Metres to degrees near 50 N, close enough for building fixtures.
const north = (m: number) => m / 111_320;
const east = (m: number) => m / (111_320 * Math.cos((50 * Math.PI) / 180));
const at = (dy: number, dx: number, day: string | null): PhotoPoint => ({
  id: `p${dy}_${dx}_${day}`,
  lat: 50 + north(dy),
  lon: -120 + east(dx),
  day,
});

describe("clusterPoints", () => {
  it("handles 50,000 photos quickly", () => {
    const big = Array.from({ length: 50_000 }, (_, i) =>
      at((i % 500) * 37, Math.floor(i / 500) * 41, `2026-01-0${1 + (i % 5)}`),
    );
    const t = performance.now();
    clusterPoints(big, []);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
