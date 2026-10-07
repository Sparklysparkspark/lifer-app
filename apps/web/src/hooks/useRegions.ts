import { useEffect, useSyncExternalStore } from "react";
import type { RegionSummary } from "@lifer/shared";
import { api } from "../api/client";

export interface RegionsState {
  regions: RegionSummary[] | null;
  error: unknown;
}

// One cached GET /regions (the full region tree without boundaries) for the whole app.
let state: RegionsState = { regions: null, error: null };
let pending: Promise<RegionSummary[]> | null = null;
const listeners = new Set<() => void>();

function emit(next: RegionsState) {
  state = next;
  listeners.forEach((l) => l());
}

export function refreshRegions(): Promise<RegionSummary[]> {
  if (!pending) {
    pending = api
      .get<{ regions: RegionSummary[] }>("/regions")
      .then((res) => {
        emit({ regions: res.regions, error: null });
        return res.regions;
      })
      .catch((err) => {
        emit({ ...state, error: err });
        throw err;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export function loadRegions(): Promise<RegionSummary[]> {
  return state.regions ? Promise.resolve(state.regions) : refreshRegions();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): RegionsState {
  return state;
}

export function useRegions(): {
  regions: RegionSummary[] | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<RegionSummary[]>;
} {
  const { regions, error } = useSyncExternalStore(subscribe, getState, getState);
  useEffect(() => {
    if (!getState().regions) loadRegions().catch(() => {});
  }, []);
  return { regions, loading: regions === null && error === null, error, refresh: refreshRegions };
}
