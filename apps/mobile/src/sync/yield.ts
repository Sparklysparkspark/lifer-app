// Keeps long background work from freezing the screen: small batches with a breath between them,
// a gate that waits out screen transitions and scrolls, and a throttle for progress ticks.
// RN-free on purpose, so the rules run in plain tests.
export const yieldNow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let gate: () => Promise<void> = () => Promise.resolve();
/** The app sets this to wait for navigation and scroll interactions to finish. */
export const setIdleGate = (fn: () => Promise<void>): void => {
  gate = fn;
};
/** Resolves when the user is not mid-transition (or soon anyway, so work never starves). */
export const settled = (): Promise<void> => gate();

/** A slicer lets a loop run for about `budgetMs` before it gives the screen a turn. */
export function slicer(budgetMs = 8, now: () => number = Date.now): () => Promise<void> {
  let start = now();
  return async () => {
    if (now() - start < budgetMs) return;
    await yieldNow();
    start = now();
  };
}

/** Runs `fn` over `items` in batches, giving the screen a turn after each. */
export async function inBatches<T>(items: readonly T[], size: number, fn: (batch: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await fn(items.slice(i, i + size));
    await yieldNow();
  }
}

/** At most one call per `ms`; the rest are dropped. Pass `force` for a value that must go through. */
export function throttle<A>(fn: (a: A) => void, ms: number, now: () => number = Date.now): (a: A, force?: boolean) => void {
  let at = -Infinity;
  return (a, force = false) => {
    const t = now();
    if (!force && t - at < ms) return;
    at = t;
    fn(a);
  };
}
