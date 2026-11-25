// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionItem } from "@lifer/shared";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...args: unknown[]) => get(...args) },
}));
const uploadJobs = { jobs: [] as Array<{ done: boolean; error?: string; skipped?: boolean }> };
vi.mock("../../lib/uploadQueue", () => ({ useUploadQueue: () => uploadJobs }));
const packStatus = {
  current: null as { lanes: { setup: { processed: number }; photos: { processed: number } } } | null,
};
vi.mock("../../hooks/usePackDownloadStatus", () => ({ usePackDownloadStatus: () => packStatus.current }));

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
  packStatus.current = null;
  resetAccountCaches();
  localStorage.clear();
});

describe("useCollectionData", () => {
  it("waits until ready, then loads the whole collection", async () => {
    route({ "/collection": { items: [item("a"), item("b", "seen")] } });
    const { result, rerender } = renderHook((props: Args) => useCollectionData(props), {
      initialProps: { ...base, ready: false },
    });
    expect(get).not.toHaveBeenCalled();
    rerender(base);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(get).toHaveBeenCalledWith("/collection");
  });

  it("shows the new scope's header count before its list arrives", async () => {
    // The list never answers: only the count can fill the header.
    route({ "/regions/r1/species/count": { total: 534, collected: 32, seen: 0 } });
    const { result, rerender } = renderHook((props: Args) => useCollectionData(props), {
      initialProps: { ...base, regionId: "r1" },
    });
    await waitFor(() => expect(result.current.regionStats).toEqual({ total: 534, collected: 32, seen: 0 }));
    route({ "/regions/r1/species/count?": { total: 534, collected: 6, seen: 0 } });
    rerender({ ...base, regionId: "r1", photographedIn: "country" });
    await waitFor(() => expect(result.current.regionStats).toEqual({ total: 534, collected: 6, seen: 0 }));
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining("photographedIn=country"));
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

  it("reports a failed load with what it threw", async () => {
    const err = new TypeError("Failed to fetch");
    get.mockImplementation((path: string) => (path === "/collection" ? Promise.reject(err) : new Promise(() => {})));
    const { result } = renderHook(() => useCollectionData(base));
    await waitFor(() => expect(result.current.loadError).toBe(err));
  });

  it("keeps the last loaded list instead of an error when a reload fails", async () => {
    route({ "/collection": { items: [item("a")] } });
    const first = renderHook(() => useCollectionData(base));
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    first.unmount();

    get.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    const { result } = renderHook(() => useCollectionData(base));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/collection"));
    await act(async () => {});
    expect(result.current.items).toHaveLength(1);
    expect(result.current.loadError).toBeNull();
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

  it("reloads as a background pack lands", async () => {
    packStatus.current = { lanes: { setup: { processed: 0 }, photos: { processed: 0 } } };
    route({ "/collection": { items: [] } });
    const { result, rerender } = renderHook((props: Args) => useCollectionData(props), { initialProps: base });
    await waitFor(() => expect(result.current.items).toEqual([]));
    route({ "/collection": { items: [item("a")] } });
    packStatus.current = { lanes: { setup: { processed: 1 }, photos: { processed: 0 } } };
    rerender(base);
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  it("patches changed rows and the counts in place", async () => {
    route({
      "/regions/r1/species/count": { total: 3, collected: 2, seen: 1 },
      "/regions/r1/species?": {
        items: [item("a"), item("b"), item("c", "seen")],
        region: { id: "r1", name: "One" },
        stats: { total: 3, collected: 2, seen: 1 },
      },
    });
    const { result } = renderHook(() => useCollectionData({ ...base, regionId: "r1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    // Seen to photographed in place moves the header's photographed count too.
    act(() => result.current.applyChange("c", { state: "collected" } as never));
    expect(result.current.regionStats).toEqual({ total: 3, collected: 3, seen: 0 });
    act(() => result.current.applyChange(["a"], "removed"));
    expect(result.current.items?.map((i) => i.speciesId)).toEqual(["b", "c"]);
    expect(result.current.regionStats).toEqual({ total: 2, collected: 2, seen: 0 });
  });
});
