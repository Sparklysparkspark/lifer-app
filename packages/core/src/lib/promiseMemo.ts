// A cache of in-flight or finished loads: concurrent callers share one promise, a rejected load is
// forgotten so the next call retries, and an entry older than `ttlMs` is loaded again.
export interface MemoEntry<T> {
  at: number;
  value: Promise<T>;
  /** The loaded value once it has resolved, for callers that update it in place. */
  resolved: T | null;
}

export interface PromiseMemo<K, T> {
  /** The live entries, for invalidation and in-place updates. */
  entries: Map<K, MemoEntry<T>>;
  get(key: K, load: () => Promise<T>): Promise<T>;
}

export function promiseMemo<K, T>(ttlMs: number): PromiseMemo<K, T> {
  const entries = new Map<K, MemoEntry<T>>();
  return {
    entries,
    get(key, load) {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const entry: MemoEntry<T> = { at: Date.now(), value: load(), resolved: null };
      entries.set(key, entry);
      entry.value.then(
        (v) => (entry.resolved = v),
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.value;
    },
  };
}
