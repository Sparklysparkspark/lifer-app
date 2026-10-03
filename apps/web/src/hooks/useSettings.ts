import { useEffect, useSyncExternalStore } from "react";
import type { LibraryRoot } from "@lifer/shared";
import { api } from "../api/client";

// Mirrors GET /settings (apps/api/src/settings/routes.ts).
export interface Settings {
  organizeOriginalsByYear: boolean;
  organizeOriginalsByLocation: boolean;
  hideObscureSpecies: boolean;
  speciesSuggestEnabled: boolean;
  anyTaxaSearchEnabled: boolean;
  technicalDiving: boolean;
  speciesNamingStyles: string[];
  abaCodesAvailable: boolean;
  dataDir: string;
  deploymentMode: "desktop" | "server";
  catalogLoading?: "running" | "failed" | null;
  libraryRoots: LibraryRoot[];
}

export interface SettingsState {
  settings: Settings | null;
  error: unknown;
}

// One cached GET /settings for the whole app. Each setting saves through its own
// PUT /settings/<name> endpoint, so callers keep their save call and mirror it with setLocal.
let state: SettingsState = { settings: null, error: null };
let pending: Promise<Settings> | null = null;
// Bumped by resetSettingsCache, so a request still in flight across a sign-out can't repopulate it.
let generation = 0;
const listeners = new Set<() => void>();

function emit(next: SettingsState) {
  state = next;
  listeners.forEach((l) => l());
}

/** Fetches once and shares the answer; a failure lets the next call retry (e.g. before sign-in). */
export function loadSettings(): Promise<Settings> {
  if (state.settings) return Promise.resolve(state.settings);
  return refreshSettings();
}

/** Always refetches (deduping concurrent calls). */
export function refreshSettings(): Promise<Settings> {
  if (!pending) {
    const gen = generation;
    const request: Promise<Settings> = api
      .get<Settings>("/settings")
      .then((res) => {
        const settings = { ...res, libraryRoots: res.libraryRoots ?? [] };
        if (gen === generation) emit({ settings, error: null });
        return settings;
      })
      .catch((err) => {
        if (gen === generation) emit({ ...state, error: err });
        throw err;
      })
      .finally(() => {
        if (pending === request) pending = null;
      });
    pending = request;
  }
  return pending;
}

/** Optimistically merges a change the caller just saved (or is about to save). */
export function setLocalSettings(patch: Partial<Settings>): void {
  if (!state.settings) return;
  emit({ settings: { ...state.settings, ...patch }, error: state.error });
}

export function getSettingsState(): SettingsState {
  return state;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Test-only, and for sign-out so the next user doesn't see a stale copy.
export function resetSettingsCache(): void {
  generation++;
  pending = null;
  emit({ settings: null, error: null });
}

export function useSettings(): {
  settings: Settings | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<Settings>;
  setLocal: (patch: Partial<Settings>) => void;
} {
  const { settings, error } = useSyncExternalStore(subscribeSettings, getSettingsState, getSettingsState);
  useEffect(() => {
    if (!getSettingsState().settings) loadSettings().catch(() => {});
  }, []);
  return { settings, loading: settings === null && error === null, error, refresh: refreshSettings, setLocal: setLocalSettings };
}
