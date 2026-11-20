// "N photos so far": kept outside the app context so a tick re-renders only the line that shows it,
// not every screen.
import { useSyncExternalStore } from "react";
import { throttle } from "./yield";

let value: number | null = null;
const listeners = new Set<() => void>();
const emit = (n: number | null) => {
  value = n;
  listeners.forEach((l) => l());
};
const ticks = throttle(emit, 500);

export const setSyncProgress = (n: number | null): void => (n === null ? emit(null) : ticks(n));
export const useSyncProgress = (): number | null =>
  useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => value,
  );
