import { describe, expect, it } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import { restoreFallback } from "./useFirstRunRegion";

const r = (id: string, name: string, parentId: string | null, hub = false): RegionSummary => ({
  id,
  name,
  parentId,
  ebirdRegionCode: null,
  boundaryGeoJson: null,
  hasChildren: false,
  hasScopedChecklist: !hub,
  sovereigntyGroup: null,
  isSovereignDependency: false,
});
const regions = [
  r("w", "World", null, true),
  r("na", "North America", "w", true),
  r("eu", "Europe", "w", true),
  r("ca", "Canada", "na"),
  r("bc", "British Columbia", "ca"),
  r("us", "United States of America", "na"),
  r("fr", "France", "eu"),
];

describe("restoreFallback", () => {
  it("keeps a region whose country is still downloaded, and always keeps hubs", () => {
    expect(restoreFallback("bc", regions, new Set(["Canada"]))).toBeNull();
    expect(restoreFallback("na", regions, new Set())).toBeNull();
  });

  it("moves to a downloaded country on the same continent first", () => {
    expect(restoreFallback("bc", regions, new Set(["France", "United States of America"]))).toBe("us");
  });

  it("then to any downloaded country, then to the continent", () => {
    expect(restoreFallback("ca", regions, new Set(["France"]))).toBe("fr");
    expect(restoreFallback("bc", regions, new Set())).toBe("na");
  });

  it("ignores a region it doesn't know", () => {
    expect(restoreFallback("gone", regions, new Set(["Canada"]))).toBeNull();
  });
});
