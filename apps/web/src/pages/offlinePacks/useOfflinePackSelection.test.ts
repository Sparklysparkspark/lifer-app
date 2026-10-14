import { describe, expect, it } from "vitest";
import type { PackStatusEntry } from "../../lib/packIndex";
import { coverageOf, selectionBytes } from "./useOfflinePackSelection";

const pack = (p: Partial<PackStatusEntry>): PackStatusEntry => ({
  id: "x",
  type: "region",
  region: "France",
  taxon: null,
  sizeBytes: 10,
  speciesCount: 1,
  contentVersion: "v",
  url: "",
  downloaded: false,
  updateAvailable: false,
  ...p,
});

describe("coverageOf", () => {
  it("is full only with a current all-taxa pack and no taxon pack left to get", () => {
    expect(coverageOf([])).toBe("none");
    expect(coverageOf([pack({ downloaded: true })])).toBe("full");
    expect(coverageOf([pack({ downloaded: true, updateAvailable: true })])).toBe("partial");
    expect(coverageOf([pack({ downloaded: true, taxon: "aves" })])).toBe("partial");
    expect(coverageOf([pack({ downloaded: true }), pack({ taxon: "aves" })])).toBe("partial");
  });
});

describe("selectionBytes", () => {
  it("counts packs still to fetch, limited to the chosen taxa", () => {
    const byRegion = new Map([
      [
        "France",
        [
          pack({ taxon: "aves", sizeBytes: 5 }),
          pack({ taxon: "mammalia", sizeBytes: 7 }),
          pack({ taxon: null, sizeBytes: 100, downloaded: true }),
          pack({ taxon: "squamata", sizeBytes: 3, downloaded: true, updateAvailable: true }),
        ],
      ],
    ]);
    expect(selectionBytes(byRegion, ["France"], new Set())).toBe(15);
    expect(selectionBytes(byRegion, ["France"], new Set(["aves"]))).toBe(5);
    expect(selectionBytes(byRegion, ["Spain"], new Set())).toBe(0);
  });
});
