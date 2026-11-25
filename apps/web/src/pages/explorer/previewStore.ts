// The group or species the pointer rests on, which the detail pane previews. A tiny store, so
// hovering re-renders only the pane, never the tree or the circle's page.
import { useSyncExternalStore } from "react";

/** How long the pointer rests before a preview shows, so sweeping across arcs doesn't flicker. */
export const DWELL_MS = 120;

let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Shows `id` (null: back to the selection) at once, dropping any preview still waiting. */
export function previewNow(id: string | null) {
  clearTimeout(timer);
  if (id === current) return;
  current = id;
  listeners.forEach((l) => l());
}

/** Shows `id` once the pointer has rested on it; touch never previews. */
export function previewAfterDwell(id: string | null, pointerType = "mouse") {
  if (pointerType === "touch") return;
  clearTimeout(timer);
  timer = setTimeout(() => previewNow(id), DWELL_MS);
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const usePreview = () => useSyncExternalStore(subscribe, () => current);
