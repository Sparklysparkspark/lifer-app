import { usePersistedState } from "../../hooks/usePersistedState";
import type { Sort } from "./cardSelection";

/** Group by: none (every sighting or observation as its own card, the default) or species. */
export type GroupBy = "none" | "species";

// Card widths the View menu's size slider moves between, in px.
export const CARD_MIN = 130;
export const CARD_MAX = 260;
export const CARD_DEFAULT = 150;

/** The View menu's choices, remembered for this person across tabs and restarts. */
export function useInatView() {
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>("inaturalist-view-group", "none");
  const [sort, setSort] = usePersistedState<Sort>("inaturalist-view-sort", "newest");
  const [cardSize, setCardSize] = usePersistedState<number>("inaturalist-view-card-size", CARD_DEFAULT);
  // "Most first" only means something for species cards.
  const effectiveSort: Sort = sort === "count" && groupBy !== "species" ? "newest" : sort;
  return { groupBy, setGroupBy, sort: effectiveSort, setSort, cardSize, setCardSize };
}

export const GROUPS: readonly GroupBy[] = ["none", "species"];
export const SORTS: readonly Sort[] = ["newest", "oldest", "name"];
// "Most first" only sorts species cards.
export const SORTS_GROUPED: readonly Sort[] = [...SORTS, "count"];

/** The groups of life present in a list, in a stable order. */
export const taxaIn = (classes: Array<string | null | undefined>) =>
  [...new Set(classes.filter((c): c is string => !!c))].sort();
