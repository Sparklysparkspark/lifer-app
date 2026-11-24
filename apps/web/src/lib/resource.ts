import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type ApiPath, type ApiResponse, type ApiRoute } from "../api/client";
import { useLatest } from "../hooks/useLatest";
import { ignore } from "./ignore";

// Module-level caches outlive a sign-out, so each one that holds account data registers here.
const accountResetters = new Set<() => void>();

/** Registers a module cache to clear when the signed-in account changes. */
export function onAccountReset(reset: () => void): void {
  accountResetters.add(reset);
}

// Caches that would otherwise keep offering a photo after it's deleted.
const photoDeleteListeners = new Set<() => void>();

/** Registers a module cache to clear once photos are deleted. */
export function onPhotosDeleted(forget: () => void): void {
  photoDeleteListeners.add(forget);
}

export function photosDeleted(): void {
  photoDeleteListeners.forEach((forget) => forget());
}

/** Clears every per-account module cache, so the next account never sees the last one's data. */
export function resetAccountCaches(): void {
  accountResetters.forEach((reset) => reset());
}

export interface Store<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
  use: () => T;
}

/** A module-level value many components read through useSyncExternalStore. */
export function createStore<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function useStore(): T {
    return useSyncExternalStore(subscribe, get, get);
  }
  return {
    get,
    set(next) {
      if (equals(value, next)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe,
    use: useStore,
  };
}

export interface ResourceState<T> {
  data: T | null;
  error: unknown;
}

export interface CachedResource<T> {
  /** The cached copy, or one shared fetch when there is none yet. A failure lets the next call retry. */
  load: () => Promise<T>;
  /** Always refetches, deduping concurrent calls. */
  refresh: () => Promise<T>;
  /** Optimistically patches the cached copy (no-op until it has loaded). */
  setLocal: (update: (data: T) => T) => void;
  getState: () => ResourceState<T>;
  subscribe: (listener: () => void) => () => void;
  /** Drops the cached copy; a request still in flight can't repopulate it. */
  reset: () => void;
  /** Subscribes and starts the first load on mount (unless `enabled` is false). */
  use: (enabled?: boolean) => ResourceState<T> & { loading: boolean; refresh: () => Promise<T> };
}

/** createCachedResource for a route without parameters, typed by its response schema. */
export function createCachedRoute<P extends ApiRoute<"get">, T>(
  path: P,
  select: (raw: ApiResponse<P>) => T,
): CachedResource<T> {
  return createCachedResource<T, ApiResponse<P>>(path, select);
}

/** One cached GET shared by the whole app, cleared with the other account caches on sign-in/out.
 *  `select` is required so an untyped path never passes its answer through unchecked. */
export function createCachedResource<T, Raw = T>(path: string, select: (raw: Raw) => T): CachedResource<T> {
  const store = createStore<ResourceState<T>>({ data: null, error: null });
  let pending: Promise<T> | null = null;
  let generation = 0;

  function refresh(): Promise<T> {
    if (!pending) {
      const gen = generation;
      const request: Promise<T> = api
        .get<Raw>(path)
        .then((raw) => {
          const data = select(raw);
          if (gen === generation) store.set({ data, error: null });
          return data;
        })
        .catch((err) => {
          if (gen === generation) store.set({ ...store.get(), error: err });
          throw err;
        })
        .finally(() => {
          if (pending === request) pending = null;
        });
      pending = request;
    }
    return pending;
  }

  function load(): Promise<T> {
    const { data } = store.get();
    return data !== null ? Promise.resolve(data) : refresh();
  }

  function reset() {
    generation++;
    pending = null;
    store.set({ data: null, error: null });
  }
  onAccountReset(reset);

  function useResource(enabled = true) {
    const state = store.use();
    useEffect(() => {
      if (enabled && store.get().data === null) load().catch(ignore(`Couldn't load ${path}`));
    }, [enabled]);
    return { ...state, loading: state.data === null && state.error === null, refresh };
  }

  return {
    load,
    refresh,
    setLocal(update) {
      const { data, error } = store.get();
      if (data !== null) store.set({ data: update(data), error });
    },
    getState: store.get,
    subscribe: store.subscribe,
    reset,
    use: useResource,
  };
}

export interface ApiResource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Refetches the current path. The shown data stays until the answer arrives; an earlier
   *  error clears while it runs. */
  reload: () => Promise<void>;
  /** Patches the shown data locally (an optimistic edit). */
  setData: (update: (prev: T | null) => T | null) => void;
}

const getJson = <T>(path: string, signal: AbortSignal) => api.get<T>(path, { signal });

// The last answer per plain GET path, so a page opened again draws at once while it refetches.
// Bounded, oldest out first; a custom fetcher's answers aren't kept (its path is only a key).
const RECENT_MAX = 50;
const recent = new Map<string, unknown>();
onAccountReset(() => recent.clear());

function remember(path: string, data: unknown): void {
  recent.delete(path);
  recent.set(path, data);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
}

const warming = new Set<string>();
/** Fetches a plain GET path into the kept answers (a card hovered), so opening it draws at once. */
export function prefetchApiResource(path: string): void {
  if (recent.has(path) || warming.has(path)) return;
  warming.add(path);
  api
    .get(path)
    .then((data) => remember(path, data), ignore(`Couldn't prefetch ${path}`))
    .finally(() => warming.delete(path));
}

/** useApiResource for one route, typed by its response schema: `useApiRoute(apiPath(...))`. */
export function useApiRoute<P extends ApiRoute<"get">>(path: ApiPath<P> | null): ApiResource<ApiResponse<P>> {
  return useApiResource<ApiResponse<P>>(path);
}

/** One page's data, keyed by its path (null skips it). A new path drops the previous path's data
 *  in the same render and aborts its request, so a late answer for an old id can never show under
 *  the new one. A plain GET starts from its last answer, if any, and refetches quietly.
 *  `fetcher` replaces the plain GET, e.g. to load several requests as one. */
export function useApiResource<T>(
  path: string | null,
  fetcher: (path: string, signal: AbortSignal) => Promise<T> = getJson,
): ApiResource<T> {
  const cached = (p: string | null) =>
    p !== null && fetcher === getJson ? ((recent.get(p) as T | undefined) ?? null) : null;
  const [state, setState] = useState<{ path: string | null; data: T | null; error: unknown }>(() => ({
    path,
    data: cached(path),
    error: null,
  }));
  if (state.path !== path) setState({ path, data: cached(path), error: null });
  const current = state.path === path ? state : { path, data: cached(path), error: null };
  const keep = fetcher === getJson;

  const fetcherRef = useLatest(fetcher);
  const keepRef = useLatest(keep);
  const pathRef = useLatest(path);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(
    (target: string): Promise<void> => {
      controller.current?.abort();
      const mine = new AbortController();
      controller.current = mine;
      return fetcherRef.current(target, mine.signal).then(
        (data) => {
          if (mine.signal.aborted) return;
          if (keepRef.current) remember(target, data);
          setState({ path: target, data, error: null });
        },
        (error) => {
          if (mine.signal.aborted) return;
          setState((prev) => ({ path: target, data: prev.path === target ? prev.data : null, error }));
        },
      );
    },
    [fetcherRef, keepRef],
  );

  useEffect(() => {
    if (path === null) return;
    void run(path);
    return () => controller.current?.abort();
  }, [path, run]);

  const reload = useCallback(() => {
    const target = pathRef.current;
    if (target === null) return Promise.resolve();
    setState((prev) => (prev.path === target ? { ...prev, error: null } : prev));
    return run(target);
  }, [pathRef, run]);
  // Local edits reach the kept copy too, so coming back doesn't briefly undo them.
  const setData = useCallback(
    (update: (prev: T | null) => T | null) =>
      setState((prev) => {
        const data = update(prev.data);
        if (keepRef.current && prev.path !== null && data !== null) remember(prev.path, data);
        return { ...prev, data };
      }),
    [keepRef],
  );

  return {
    data: current.data,
    error: current.error,
    loading: path !== null && current.data === null && current.error === null,
    reload,
    setData,
  };
}
