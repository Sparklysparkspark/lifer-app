// A tiny in-process semaphore. Used where a module needs to cap how many heavy operations
// (ffmpeg, RAW processing, reference photo downloads) run at once.

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// Small concurrency-limited map, for per-item HTTP calls (e.g. one GBIF request per species).
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  // Stryker disable next-line ArrayDeclaration: equivalent, every index is filled before it returns
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
