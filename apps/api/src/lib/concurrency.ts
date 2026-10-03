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
