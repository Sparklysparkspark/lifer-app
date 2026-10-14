// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryItem, GalleryQuery } from "./types";

const get = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...args: unknown[]) => get(...args) },
}));
const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));

const { useGalleryListing } = await import("./useGalleryListing");

const query: GalleryQuery = {
  searchQuery: "",
  onlyHidden: false,
  onlyTopRated: false,
  onlyFeatured: false,
  missingDate: false,
  shotKind: null,
  tier: null,
  tierRegionId: null,
  selectedTaxa: new Set(),
  rawFiles: "show",
  editedRaw: "any",
  mediaFilter: "both",
  dateFrom: "",
  dateTo: "",
  regionId: null,
  tag: null,
  scopeTripId: null,
  scopeAlbumId: null,
  sortBy: "newest",
};

const photo = (id: string) => ({ captureId: id, photoId: id }) as GalleryItem;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function render(initial: GalleryQuery = query) {
  return renderHook(
    ({ q, lightboxIndex }: { q: GalleryQuery; lightboxIndex: number | null }) =>
      useGalleryListing({ query: q, groupByRegion: false, lightboxIndex }),
    { initialProps: { q: initial, lightboxIndex: null as number | null } },
  );
}

beforeEach(() => {
  get.mockReset();
  toast.error.mockReset();
});

describe("useGalleryListing", () => {
  it("loads the first page and the next one on demand, skipping repeats", async () => {
    get
      .mockResolvedValueOnce({ items: [photo("a"), photo("b")], nextCursor: "c1", total: 3 })
      .mockResolvedValueOnce({ items: [photo("b"), photo("c")], nextCursor: null });
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.total).toBe(3);
    expect(get.mock.calls[0][0]).toMatch(/^\/gallery\?.*limit=200/);
    act(() => result.current.loadMoreRef.current());
    await waitFor(() => expect(result.current.items?.map((i) => i.captureId)).toEqual(["a", "b", "c"]));
    expect(result.current.nextCursor).toBeNull();
  });

  it("cancels the previous filter's request so its answer can't land on the new one", async () => {
    const slow = deferred<unknown>();
    get.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ items: [photo("fav")], nextCursor: null, total: 1 });
    const { result, rerender } = render();
    rerender({ q: { ...query, onlyTopRated: true }, lightboxIndex: null });
    await waitFor(() => expect(result.current.items?.map((i) => i.captureId)).toEqual(["fav"]));
    expect((get.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    await act(async () => slow.resolve({ items: [photo("old")], nextCursor: null, total: 1 }));
    expect(result.current.items?.map((i) => i.captureId)).toEqual(["fav"]);
  });

  it("shows the quick search pass, then lets the full pass replace it", async () => {
    const full = deferred<unknown>();
    get.mockImplementation((path: string) =>
      path.includes("quick=1")
        ? Promise.resolve({ items: [photo("quick")], pending: true, interpretation: null })
        : full.promise,
    );
    const { result } = render({ ...query, searchQuery: "heron" });
    await waitFor(() => expect(result.current.items?.map((i) => i.captureId)).toEqual(["quick"]));
    expect(result.current.searching).toBe(true);
    await act(async () => full.resolve({ items: [photo("full")], pending: false, interpretation: null }));
    expect(result.current.items?.map((i) => i.captureId)).toEqual(["full"]);
    expect(result.current.searching).toBe(false);
  });

  it("reports a failed load", async () => {
    get.mockRejectedValue(new Error("offline"));
    const { result } = render();
    await waitFor(() => expect(result.current.loadError).toBeTruthy());
  });

  it("selects every matching photo by id when pages are still unloaded", async () => {
    get
      .mockResolvedValueOnce({ items: [photo("a")], nextCursor: "c1", total: 3 })
      .mockResolvedValueOnce({ captureIds: ["a", "b", "c"], videoCaptureIds: ["c"], rawCaptureIds: [] });
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const select = vi.fn();
    await act(() => result.current.selectAll(select));
    expect(select).toHaveBeenCalledWith(new Set(["a", "b", "c"]));
    expect(result.current.selectAllMeta?.video).toEqual(new Set(["c"]));
  });

  it("reloads as many photos as were showing, so the grid keeps its place", async () => {
    get
      .mockResolvedValueOnce({ items: [photo("a")], nextCursor: "c1", total: 3 })
      .mockResolvedValueOnce({ items: [photo("b")], nextCursor: "c2" })
      .mockResolvedValueOnce({ items: [photo("a")], nextCursor: "c1", total: 3 })
      .mockResolvedValueOnce({ items: [photo("b")], nextCursor: "c2" });
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => result.current.loadMoreRef.current());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    act(() => result.current.load({ keepLoaded: true }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(result.current.items?.map((i) => i.captureId)).toEqual(["a", "b"]));
  });
});
