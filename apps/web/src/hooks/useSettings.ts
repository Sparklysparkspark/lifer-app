import type { SettingsResponse } from "@lifer/shared";
import { createCachedRoute, type ResourceState } from "../lib/resource";

// GET /settings (apps/api/src/settings/routes.ts).
export type Settings = SettingsResponse;

export interface SettingsState {
  settings: Settings | null;
  error: unknown;
}

// One cached GET /settings for the whole app. Each setting saves through its own
// PUT /settings/<name> endpoint, so callers keep their save call and mirror it with setLocal.
const settingsResource = createCachedRoute("/settings", (res): Settings => ({
  ...res,
  libraryRoots: res.libraryRoots ?? [],
}));

/** Fetches once and shares the answer; a failure lets the next call retry (e.g. before sign-in). */
export const loadSettings = settingsResource.load;

/** Always refetches (deduping concurrent calls). */
export const refreshSettings = settingsResource.refresh;

/** Optimistically merges a change the caller just saved (or is about to save). */
export function setLocalSettings(patch: Partial<Settings>): void {
  settingsResource.setLocal((settings) => ({ ...settings, ...patch }));
}

// Derived per state object, so useSyncExternalStore sees a stable snapshot.
let derivedFrom: ResourceState<Settings> | null = null;
let derived: SettingsState = { settings: null, error: null };
export function getSettingsState(): SettingsState {
  const state = settingsResource.getState();
  if (state !== derivedFrom) {
    derivedFrom = state;
    derived = { settings: state.data, error: state.error };
  }
  return derived;
}

export const subscribeSettings = settingsResource.subscribe;

// Test-only (sign-out goes through resetAccountCaches, which includes this).
export const resetSettingsCache = settingsResource.reset;

export function useSettings(): {
  settings: Settings | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<Settings>;
  setLocal: (patch: Partial<Settings>) => void;
} {
  const { data, loading, error, refresh } = settingsResource.use();
  return { settings: data, loading, error, refresh, setLocal: setLocalSettings };
}
