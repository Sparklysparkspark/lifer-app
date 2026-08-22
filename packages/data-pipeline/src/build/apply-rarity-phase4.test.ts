// Regression coverage for two bugs:
// 1. A species missing from the crawl map used to default to elusiveness 0.5 ("mid-pack" /
//    unknown). Never once clearing a real-world reporting threshold anywhere (e.g. Wolverine,
//    or many bats) is itself evidence of being hard to detect, not a neutral unknown — the
//    default was bumped to 0.75.
// 2. species.gbif_key is a bigint column; node-postgres returns bigint as a STRING at
//    runtime even though the TS type says number, so a numeric-keyed Map missed every
//    lookup until Number() coercion was added.
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
