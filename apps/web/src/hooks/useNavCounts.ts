import { useEffect } from "react";
import { createStore, onAccountReset } from "../lib/resource";

// The collection publishes its "collected / total" count here for the nav to show.
type NavCounts = { collected: number; total: number } | null;
const navCounts = createStore<NavCounts>(null, (a, b) => a?.collected === b?.collected && a?.total === b?.total);
onAccountReset(() => navCounts.set(null));

/** Shows "collected / total" under the logo while the calling page is mounted. */
export function useNavCounts(collected: number, total: number | null): void {
  useEffect(() => {
    navCounts.set(total == null ? null : { collected, total });
  }, [collected, total]);
  useEffect(() => () => navCounts.set(null), []);
}

/** The counts the collection last published, for the nav. */
export function useNavCountsValue(): NavCounts {
  return navCounts.use();
}
