// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RegionSummary } from "@lifer/shared";
import type { PackStatusEntry } from "../../lib/packIndex";
import { coverageOf, selectionBytes, useOfflinePackSelection } from "./useOfflinePackSelection";

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
  it("counts packs still to fetch for the chosen taxa, and none when nothing is chosen", () => {
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
    expect(selectionBytes(byRegion, ["France"], new Set())).toBe(0);
    expect(selectionBytes(byRegion, ["France"], new Set(["aves", "mammalia"]))).toBe(12);
    expect(selectionBytes(byRegion, ["France"], new Set(["aves"]))).toBe(5);
    expect(selectionBytes(byRegion, ["Spain"], new Set())).toBe(0);
  });
});

describe("useOfflinePackSelection", () => {
  const region = (id: string, name: string, parentId: string | null) =>
    ({ id, name, parentId, sovereigntyGroup: null, isSovereignDependency: false }) as RegionSummary;
  const regions = [region("w", "World", null), region("eu", "Europe", "w"), region("fr", "France", "eu")];
  const packs = [pack({ id: "a", taxon: "aves", sizeBytes: 5 }), pack({ id: "m", taxon: "mammalia", sizeBytes: 7 })];

  it("offers a selected country's taxa and sizes the selection", () => {
    const { result } = renderHook(() => useOfflinePackSelection(regions, packs));
    act(() => result.current.toggleCountry("fr"));
    expect(result.current.selectedCountryNames).toEqual(["France"]);
    expect(result.current.availableTaxaForSelection.sort()).toEqual(["aves", "mammalia"]);
    expect(result.current.selectionSizeBytes).toBe(0);
    act(() => result.current.toggleTaxon("aves"));
    expect(result.current.selectionSizeBytes).toBe(5);
  });

  it("deselects a continent's countries when it closes", () => {
    const { result } = renderHook(() => useOfflinePackSelection(regions, packs));
    act(() => result.current.toggleCountry("fr"));
    expect(result.current.openContinentIds.has("eu")).toBe(true);
    act(() => result.current.toggleContinent("eu"));
    expect(result.current.selectedCountryIds.size).toBe(0);
  });
});
