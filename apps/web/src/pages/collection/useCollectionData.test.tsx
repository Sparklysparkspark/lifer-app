// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem } from "@lifer/shared";

const get = vi.fn();
vi.mock("../../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));
const uploadJobs = { jobs: [] as Array<{ done: boolean; error?: string; skipped?: boolean }> };
vi.mock("../../lib/uploadQueue", () => ({ useUploadQueue: () => uploadJobs }));

const { useCollectionData } = await import("./useCollectionData");
const { resetAccountCaches } = await import("../../lib/resource");

function item(speciesId: string, state: CollectionItem["state"] = "collected"): CollectionItem {
  return { speciesId, state } as CollectionItem;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Args = Parameters<typeof useCollectionData>[0];
const base: Args = {
  regionId: null,
  taxonRaw: "",
  singleTaxonFilter: undefined,
  seaZoneIds: [],
  includeLand: true,
  seaZonesRelevant: false,
  regionKnownHub: false,
  firstRunPrompt: false,
  ready: true,
};

// Answers by path prefix; anything unlisted never resolves.
function route(answers: Record<string, unknown>) {
  get.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k));
    return key ? Promise.resolve(answers[key]) : new Promise(() => {});
  });
}

beforeEach(() => {
  get.mockReset();
  uploadJobs.jobs = [];
  resetAccountCaches();
  localStorage.clear();
});

describe("useCollectionData", () => {
  it("waits until ready, then loads the whole collection and its quick count", async () => {
    route({
      "/collection/count": { total: 2, collected: 1 },
      "/collection": { items: [item("a"), item("b", "seen")] },
    });
    const { result, rerender } = renderHook((props: Args) => useCollectionData(props), {
      initialProps: { ...base, ready: false },
    });
    expect(get).not.toHaveBeenCalled();
    rerender(base);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.quickCount).toEqual({ total: 2, collected: 1 });
    expect(get).toHaveBeenCalledWith("/collection");
  });

  it("ignores a slower answer for the region it just left", async () => {
    const slow = deferred<unknown>();
    get.mockImplementation((path: string) => {
      if (path.startsWith("/regions/r1/species?")) return slow.promise;
      if (path.startsWith("/regions/r2/species?"))
        return Promise.resolve({ items: [item("new")], region: { id: "r2", name: "Two" }, stats: null });
      return new Promise(() => {});
    });
    const { result, rerender } = renderHook((props: Args) => useCollectionData(props), {
      initialProps: { ...base, regionId: "r1" },
    });
    rerender({ ...base, regionId: "r2" });
    await waitFor(() => expect(result.current.items?.map((i) => i.speciesId)).toEqual(["new"]));
    await act(async () => slow.resolve({ items: [item("old")], region: { id: "r1", name: "One" }, stats: null }));
    expect(result.current.items?.map((i) => i.speciesId)).toEqual(["new"]);
    expect(result.current.regionMeta?.id).toBe("r2");
  });

  it("flags a region without a downloaded pack", async () => {
    route({
      "/regions/r1/species?": { items: [], region: { id: "r1", name: "One" }, stats: null, needsPack: true },
    });
    const { result } = renderHook(() => useCollectionData({ ...base, regionId: "r1" }));
    await waitFor(() => expect(result.current.needsPackFor).toEqual({ id: "r1", name: "One" }));
  });

  it("aggregates a hub's downloaded countries", async () => {
    route({ "/regions/eu/aggregate-species": { items: [item("a")], downloadedCountryNames: ["France"] } });
    const { result } = renderHook(() => useCollectionData({ ...base, regionId: "eu", regionKnownHub: true }));
    await waitFor(() => expect(result.current.downloadedHubCountryNames).toEqual(["France"]));
    expect(result.current.items).toHaveLength(1);
  });

  it("reports a failed load", async () => {
    get.mockImplementation((path: string) =>
      path === "/collection" ? Promise.reject(new Error("offline")) : new Promise(() => {}),
    );
    const { result } = renderHook(() => useCollectionData(base));
    await waitFor(() => expect(result.current.loadError).toBe(true));
  });

  it("draws the cached list at once on remount, until an account change clears it", async () => {
    route({ "/collection": { items: [item("a")] } });
    const first = renderHook(() => useCollectionData(base));
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    first.unmount();

    get.mockImplementation(() => new Promise(() => {}));
    const second = renderHook(() => useCollectionData(base));
    expect(second.result.current.items).toHaveLength(1);
    second.unmount();

    resetAccountCaches();
    const third = renderHook(() => useCollectionData(base));
    expect(third.result.current.items).toBeNull();
  });

  it("patches changed rows and the counts in place", async () => {
    route({
      "/regions/r1/species/count": { total: 3, collected: 2 },
      "/regions/r1/species?": {
        items: [item("a"), item("b"), item("c", "seen")],
        region: { id: "r1", name: "One" },
        stats: { total: 3, collected: 2, seen: 1 },
      },
    });
    const { result } = renderHook(() => useCollectionData({ ...base, regionId: "r1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    act(() => result.current.applyChange("c", { state: "collected" } as never));
    expect(result.current.regionStats).toEqual({ total: 3, collected: 2, seen: 0 });
    act(() => result.current.applyChange(["a"], "removed"));
    expect(result.current.items?.map((i) => i.speciesId)).toEqual(["b", "c"]);
    expect(result.current.regionStats).toEqual({ total: 2, collected: 1, seen: 0 });
    expect(result.current.quickCount).toEqual({ total: 2, collected: 1 });
  });
});
