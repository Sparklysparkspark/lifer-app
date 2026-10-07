import { useEffect, useSyncExternalStore } from "react";

// The collection publishes its "collected / total" count here for the nav to show.
type NavCounts = { collected: number; total: number } | null;
let counts: NavCounts = null;
const listeners = new Set<() => void>();
function setCounts(next: NavCounts) {
  if (counts?.collected === next?.collected && counts?.total === next?.total) return;
  counts = next;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const getCounts = () => counts;

/** Shows "collected / total" under the logo while the calling page is mounted. */
export function useNavCounts(collected: number, total: number | null): void {
  useEffect(() => {
    setCounts(total == null ? null : { collected, total });
  }, [collected, total]);
  useEffect(() => () => setCounts(null), []);
}

/** The counts the collection last published, for the nav. */
export function useNavCountsValue(): NavCounts {
  return useSyncExternalStore(subscribe, getCounts, getCounts);
}
