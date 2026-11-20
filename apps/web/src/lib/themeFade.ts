import { flushSync } from "react-dom";

// A theme or dark-page switch is one window-wide cross-fade between two finished images (the View
// Transitions API; styled in index.css). Plugin frames are given their new theme inside the update,
// so the "new" snapshot already shows it.
const PLUGIN_WAIT_MS = 150;

type ThemeSync = () => Promise<void>;
const syncs = new Set<ThemeSync>();

/** A plugin host registers how to hand its page the current theme and await its confirmation. */
export function registerThemeSync(sync: ThemeSync): () => void {
  syncs.add(sync);
  return () => syncs.delete(sync);
}

export function withThemeTransition(update: () => void): void {
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.startViewTransition(async () => {
    flushSync(update);
    await Promise.all([...syncs].map((sync) => sync()));
  });
}

/** Resolves on `done` or after the wait, whichever comes first, so navigation is never held up. */
export function waitApplied(arm: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, PLUGIN_WAIT_MS);
    arm(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}
