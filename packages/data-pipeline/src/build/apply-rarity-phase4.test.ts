// Covers two behaviours:
// 1. A species missing from the crawl map defaults to elusiveness 0.75, not 0.5: never clearing a
//    reporting threshold anywhere is evidence of being hard to detect.
// 2. species.gbif_key is bigint, which node-postgres returns as a string, so lookups need Number().
import { describe, expect, it } from "vitest";
import { resolveRawElusivenessScore } from "./apply-rarity-phase4.js";

describe("resolveRawElusivenessScore", () => {
  it("returns the real crawled score when the species has one", () => {
    const map = new Map([[12345, 0.12]]);
    expect(resolveRawElusivenessScore(map, 12345)).toBe(0.12);
  });

  it("defaults to 0.75 (hard-to-detect), not 0.5 (neutral), for a species absent from every crawled country", () => {
    const map = new Map([[12345, 0.12]]);
    expect(resolveRawElusivenessScore(map, 99999)).toBe(0.75);
  });

  it("coerces a stringified gbif_key (the real runtime shape from node-postgres bigint columns)", () => {
    const map = new Map([[12345, 0.12]]);
    expect(resolveRawElusivenessScore(map, "12345")).toBe(0.12);
    expect(resolveRawElusivenessScore(map, "99999")).toBe(0.75);
  });
});
