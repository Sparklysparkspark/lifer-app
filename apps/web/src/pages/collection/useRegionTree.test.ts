// @vitest-environment jsdom
// The Collection only ever offers regions reachable from a downloaded country: while the pack list
// loads, when it fails (falling back to the countries the Collection's own data names), and offline.
import { renderHook } from "@testing-library/react";
import type { RegionSummary } from "@lifer/shared";
import { describe, expect, it, vi } from "vitest";
import type { PackStatusEntry } from "../../lib/packIndex";

const region = (id: string, name: string, parentId: string | null, scoped = true) =>
  ({ id, name, parentId, hasScopedChecklist: scoped, hasChildren: false }) as RegionSummary;
const REGIONS = [
  region("world", "World", null, false),
  region("na", "North America", "world", false),
  region("ca", "Canada", "na"),
  region("us", "United States", "na"),
  region("mx", "Mexico", "na"),
  region("mb", "Manitoba", "ca"),
  region("prairies", "The Prairies", "ca"),
  region("sk", "Saskatchewan", "prairies"),
  region("aw", "Aruba", "na"),
  region("aw-1", "Aruba", "aw"),
];
vi.mock("../../hooks/useRegions", () => ({
  useRegions: () => ({ regions: REGIONS, error: null, refresh: vi.fn() }),
}));
let index: { packs: PackStatusEntry[] | null; error: unknown; indexUnavailable?: boolean };
vi.mock("../../lib/packIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/packIndex")>()),
  usePackIndex: () => ({ freeBytes: null, indexUnavailable: false, loading: false, refresh: vi.fn(), ...index }),
}));
const { useRegionTree } = await import("./useRegionTree");

const canadaBirds = {
  id: "ca-aves",
  type: "region",
  region: "Canada",
  taxon: "aves",
  downloaded: true,
} as PackStatusEntry;
const names = (rs: RegionSummary[]) => rs.map((r) => r.name);

describe("useRegionTree only offers downloaded countries", () => {
  it("offline with only Canada installed: North America lists Canada, World lists North America", () => {
    index = { packs: [canadaBirds], error: null, indexUnavailable: true };
    expect(names(renderHook(() => useRegionTree("na")).result.current.children)).toEqual(["Canada"]);
    const world = renderHook(() => useRegionTree("world")).result.current;
    expect(names(world.children)).toEqual(["North America"]);
    expect(names(world.downloadedCountries)).toEqual(["Canada"]);
  });

  it("offers no area while the pack list is still loading", () => {
    index = { packs: null, error: null };
    expect(renderHook(() => useRegionTree("na")).result.current.children).toEqual([]);
    expect(renderHook(() => useRegionTree("world")).result.current.children).toEqual([]);
  });

  it("when the pack list fails, uses the countries the Collection's data names instead of all", () => {
    index = { packs: null, error: new Error("503") };
    const tree = renderHook(() => useRegionTree("na", ["Canada"])).result.current;
    expect(names(tree.children)).toEqual(["Canada"]);
    expect(names(tree.downloadedCountries)).toEqual(["Canada"]);
    expect([...(tree.availableRegionIds ?? [])]).not.toContain("us");
    // Nothing known at all: still nothing offered, never every country.
    expect(renderHook(() => useRegionTree("na")).result.current.children).toEqual([]);
  });
});

describe("useRegionTree with a group holding one province", () => {
  it("lists the group opening the province, and sends the group's own id to the province", () => {
    index = { packs: [canadaBirds], error: null };
    const canada = renderHook(() => useRegionTree("ca")).result.current;
    expect(canada.children.map((r) => `${r.name}>${r.id}`)).toEqual(["Manitoba>mb", "The Prairies>sk"]);
    const group = renderHook(() => useRegionTree("prairies")).result.current;
    expect(group.landingId).toBe("sk");
    expect(renderHook(() => useRegionTree("sk")).result.current.breadcrumb.at(-1)?.name).toBe("The Prairies");
  });

  it("doesn't redirect before the pack list says what's available", () => {
    index = { packs: null, error: null };
    expect(renderHook(() => useRegionTree("prairies")).result.current.landingId).toBe("prairies");
  });
});

describe("useRegionTree with a country whose only area has its name", () => {
  const arubaBirds = { ...canadaBirds, id: "aw-aves", region: "Aruba" } as PackStatusEntry;

  it("shows the country with no areas, and sends the area's id to the country", () => {
    index = { packs: [arubaBirds], error: null };
    const aruba = renderHook(() => useRegionTree("aw")).result.current;
    expect(aruba.landingId).toBe("aw");
    expect(aruba.children).toEqual([]);
    expect(aruba.allChildren).toEqual([]);
    const area = renderHook(() => useRegionTree("aw-1")).result.current;
    expect(area.landingId).toBe("aw");
    expect(names(area.breadcrumb)).toEqual(["World", "North America", "Aruba"]);
  });
});
