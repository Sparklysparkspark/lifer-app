// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api/client", () => ({ api: { get: (...args: unknown[]) => get(...args) } }));

const { createCachedResource, createStore, onAccountReset, resetAccountCaches, useApiResource } =
  await import("./resource");

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
    const things = createCachedResource<number>("/n");
    get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("down"));
    await expect(things.load()).rejects.toThrow("offline");
    expect(things.getState()).toMatchObject({ data: null, error: expect.any(Error) });
    await expect(things.load()).resolves.toBe(1);
    await expect(things.refresh()).rejects.toThrow("down");
    expect(things.getState().data).toBe(1);
  });

  it("drops a response that lands after an account reset", async () => {
    const things = createCachedResource<string>("/me");
    const pending = deferred<string>();
    get.mockReturnValueOnce(pending.promise);
    const stale = things.load();
    resetAccountCaches();
    pending.resolve("previous account");
    await stale;
    expect(things.getState().data).toBeNull();
  });

  it("patches the cached copy locally once loaded", async () => {
    const things = createCachedResource<{ n: number }>("/obj");
    things.setLocal((d) => ({ n: d.n + 1 }));
    expect(things.getState().data).toBeNull();
    get.mockResolvedValue({ n: 1 });
    await things.load();
    things.setLocal((d) => ({ n: d.n + 1 }));
    expect(things.getState().data).toEqual({ n: 2 });
  });

  it("loads on mount and re-renders subscribers", async () => {
    const things = createCachedResource<string>("/hook");
    get.mockResolvedValue("hello");
    const { result } = renderHook(() => things.use());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("hello"));
    expect(result.current.loading).toBe(false);
  });

  it("doesn't load while disabled", () => {
    const things = createCachedResource<string>("/off");
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
});
