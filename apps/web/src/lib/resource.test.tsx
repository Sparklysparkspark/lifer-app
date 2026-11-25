// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

const {
  createCachedResource,
  createStore,
  onAccountReset,
  prefetchApiResource,
  resetAccountCaches,
  useApiResource,
  usePrefetchWhenIdle,
} = await import("./resource");
const { noteAnswer } = await import("../api/answers");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  get.mockReset();
  resetAccountCaches();
});

describe("createCachedResource", () => {
  it("shares one request between concurrent loads and serves later ones from the cache", async () => {
    const things = createCachedResource<string[], { items: string[] }>("/things", (r) => r.items);
    get.mockResolvedValue({ items: ["a"] });
    const results = await Promise.all([things.load(), things.load(), things.refresh()]);
    await things.load();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/things");
    expect(results).toEqual([["a"], ["a"], ["a"]]);
  });

  it("keeps the last good data when a refresh fails, and retries on the next load after a first failure", async () => {
    const things = createCachedResource<number>("/n", (r) => r);
    get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("down"));
    await expect(things.load()).rejects.toThrow("offline");
    expect(things.getState()).toMatchObject({ data: null, error: expect.any(Error) });
    await expect(things.load()).resolves.toBe(1);
    await expect(things.refresh()).rejects.toThrow("down");
    expect(things.getState().data).toBe(1);
  });

  it("drops a response that lands after an account reset", async () => {
    const things = createCachedResource<string>("/me", (r) => r);
    const pending = deferred<string>();
    get.mockReturnValueOnce(pending.promise);
    const stale = things.load();
    resetAccountCaches();
    pending.resolve("previous account");
    await stale;
    expect(things.getState().data).toBeNull();
  });

  it("patches the cached copy locally once loaded", async () => {
    const things = createCachedResource<{ n: number }>("/obj", (r) => r);
    things.setLocal((d) => ({ n: d.n + 1 }));
    expect(things.getState().data).toBeNull();
    get.mockResolvedValue({ n: 1 });
    await things.load();
    things.setLocal((d) => ({ n: d.n + 1 }));
    expect(things.getState().data).toEqual({ n: 2 });
  });

  it("loads on mount and re-renders subscribers", async () => {
    const things = createCachedResource<string>("/hook", (r) => r);
    get.mockResolvedValue("hello");
    const { result } = renderHook(() => things.use());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("hello"));
    expect(result.current.loading).toBe(false);
  });

  it("doesn't load while disabled", () => {
    const things = createCachedResource<string>("/off", (r) => r);
    renderHook(() => things.use(false));
    expect(get).not.toHaveBeenCalled();
  });
});

describe("createStore and account resets", () => {
  it("skips notifying when the new value is equal", () => {
    const store = createStore({ n: 1 }, (a, b) => a.n === b.n);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ n: 1 });
    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("runs every registered reset", () => {
    const reset = vi.fn();
    onAccountReset(reset);
    resetAccountCaches();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("useApiResource", () => {
  it("never shows an old id's late answer under a new id", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    get.mockImplementation((path: string) => (path === "/trips/a" ? first.promise : second.promise));
    const { result, rerender } = renderHook(({ path }) => useApiResource<string>(path), {
      initialProps: { path: "/trips/a" },
    });
    rerender({ path: "/trips/b" });
    const firstSignal = get.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    await act(async () => first.resolve("trip a"));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => second.resolve("trip b"));
    expect(result.current.data).toBe("trip b");
  });

  it("clears the previous id's data in the same render", async () => {
    get.mockResolvedValueOnce("album a").mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ path }) => useApiResource<string>(path), {
      initialProps: { path: "/albums/a" as string | null },
    });
    await waitFor(() => expect(result.current.data).toBe("album a"));
    rerender({ path: "/albums/b" });
    expect(result.current.data).toBeNull();
    rerender({ path: null });
    expect(result.current.loading).toBe(false);
  });

  it("reloads in place, keeping the data while it runs and clearing an earlier error", async () => {
    get.mockResolvedValueOnce("v1").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("v2");
    const { result } = renderHook(() => useApiResource<string>("/x"));
    await waitFor(() => expect(result.current.data).toBe("v1"));
    await act(() => result.current.reload());
    expect(result.current.data).toBe("v1");
    expect(result.current.error).toBeInstanceOf(Error);
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ data: "v2", error: null });
  });

  it("uses a custom fetcher and applies local edits", async () => {
    const fetcher = vi.fn(async (path: string) => ({ path, items: [1, 2] }));
    const { result } = renderHook(() => useApiResource("/combined", fetcher));
    await waitFor(() => expect(result.current.data?.items).toEqual([1, 2]));
    act(() => result.current.setData((d) => (d ? { ...d, items: [1] } : d)));
    expect(result.current.data?.items).toEqual([1]);
    expect(get).not.toHaveBeenCalled();
  });

  it("opens again on the last answer and swaps in the fresh one when it lands", async () => {
    get.mockResolvedValueOnce("v1");
    const first = renderHook(() => useApiResource<string>("/stats"));
    await waitFor(() => expect(first.result.current.data).toBe("v1"));
    first.unmount();

    const fresh = deferred<string>();
    get.mockReturnValueOnce(fresh.promise);
    const second = renderHook(() => useApiResource<string>("/stats"));
    expect(second.result.current).toMatchObject({ data: "v1", loading: false });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve("v2"));
    expect(second.result.current.data).toBe("v2");
  });

  it("keeps local edits for the next visit", async () => {
    get.mockResolvedValueOnce(["a", "b"]).mockReturnValueOnce(new Promise(() => {}));
    const first = renderHook(() => useApiResource<string[]>("/albums/x"));
    await waitFor(() => expect(first.result.current.data).toEqual(["a", "b"]));
    act(() => first.result.current.setData((d) => d?.filter((v) => v !== "b") ?? d));
    first.unmount();
    const second = renderHook(() => useApiResource<string[]>("/albums/x"));
    expect(second.result.current.data).toEqual(["a"]);
  });

  it("starts empty after an account reset, and never keeps a custom fetcher's answer", async () => {
    get.mockResolvedValueOnce("mine");
    const first = renderHook(() => useApiResource<string>("/trips"));
    await waitFor(() => expect(first.result.current.data).toBe("mine"));
    first.unmount();
    resetAccountCaches();
    get.mockReturnValueOnce(new Promise(() => {}));
    expect(renderHook(() => useApiResource<string>("/trips")).result.current.data).toBeNull();

    const fetcher = vi.fn(async () => "combined");
    const custom = renderHook(() => useApiResource("/both", fetcher));
    await waitFor(() => expect(custom.result.current.data).toBe("combined"));
    custom.unmount();
    fetcher.mockReturnValueOnce(new Promise(() => {}));
    expect(renderHook(() => useApiResource("/both", fetcher)).result.current.data).toBeNull();
  });
});

describe("prefetchApiResource", () => {
  it("warms a path once, so opening it draws at once", async () => {
    const answer = deferred<{ name: string }>();
    get.mockReturnValueOnce(answer.promise);
    prefetchApiResource("/albums/a?limit=200");
    prefetchApiResource("/albums/a?limit=200");
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => answer.resolve({ name: "Birds" }));
    get.mockReturnValueOnce(new Promise(() => {}));
    expect(renderHook(() => useApiResource("/albums/a?limit=200")).result.current.data).toEqual({ name: "Birds" });
    prefetchApiResource("/albums/a?limit=200");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("kept answers' size bound", () => {
  it("lets the oldest big answers go once together they pass the bound, keeping the newest", async () => {
    // Four 30 MB trees: the 80 MB bound keeps the last two.
    get.mockImplementation(async (path: string) => {
      const data = { path };
      noteAnswer(path, data, 30_000_000, null);
      return data;
    });
    for (const id of [1, 2, 3, 4]) await prefetchApiResource(`/tree?r=${id}`);
    get.mockReturnValue(new Promise(() => {}));
    const shown = (id: number) => renderHook(() => useApiResource(`/tree?r=${id}`)).result.current.data;
    expect([shown(1), shown(2)]).toEqual([null, null]);
    expect([shown(3), shown(4)]).toEqual([{ path: "/tree?r=3" }, { path: "/tree?r=4" }]);
  });
});

describe("usePrefetchWhenIdle", () => {
  it("fetches one path at a time in idle time, and a page opened meanwhile waits for it instead", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<string>();
      const second = deferred<string>();
      get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      renderHook(() => usePrefetchWhenIdle(["/tree?r=a", "/tree?r=b"]));
      expect(get).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(500));
      expect(get.mock.calls.map((c) => c[0])).toEqual(["/tree?r=a"]);
      await act(async () => first.resolve("A"));
      await act(async () => vi.advanceTimersByTime(500));
      expect(get.mock.calls.map((c) => c[0])).toEqual(["/tree?r=a", "/tree?r=b"]);

      const page = renderHook(() => useApiResource<string>("/tree?r=b"));
      await act(async () => second.resolve("B"));
      expect(page.result.current.data).toBe("B");
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
