import { lazy, type ComponentType } from "react";

/** lazy() whose code can be fetched ahead with `preload()`. Once it has arrived the page renders at
 *  once: lazy() over a pending import() always suspends, and React then holds the page back for
 *  its 300 ms Suspense reveal throttle. */
export function preloadablePage<T extends ComponentType>(load: () => Promise<{ default: T }>) {
  let loaded: { default: T } | undefined;
  const preload = () => load().then((module) => (loaded = module));
  // A thenable that answers synchronously, so React reads the page in the same render.
  const Page = lazy(() =>
    loaded ? ({ then: (done: (m: { default: T }) => void) => done(loaded!) } as never) : preload(),
  );
  return Object.assign(Page, { preload });
}
