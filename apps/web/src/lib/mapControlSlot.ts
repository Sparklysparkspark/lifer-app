import { useSyncExternalStore } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

// The top-right control stack of each map (MapLayersControl) has a slot left of the layers button
// for a page's own controls (the Collection map's Reset view), so they line up in one row with no
// gaps and fade together. Pages portal into it with `useMapControlSlot`.
const slots = new WeakMap<MapLibreMap, HTMLElement>();
const listeners = new Set<() => void>();

export function publishMapControlSlot(map: MapLibreMap, el: HTMLElement | null): void {
  if (el) slots.set(map, el);
  else slots.delete(map);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The element to portal a top-right map control into, or null until the map's stack exists. */
export function useMapControlSlot(map: MapLibreMap | null): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => (map && slots.get(map)) || null);
}
