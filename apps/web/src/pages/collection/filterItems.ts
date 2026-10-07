import type { CollectionItem } from "@lifer/shared";
import type { StateFilter } from "./useCollectionUrlState";
import { broadGroups } from "../../lib/broadGroups";
import { normalizeForSearch } from "../../lib/searchNormalize";

// The same rules as quick search, so a name found in one is found in the other.
export const normalizeSearchText = normalizeForSearch;

// Extra names some rows may carry (not every endpoint sends them).
type SearchableExtras = {
  aliases?: string[] | null;
  codes?: string[] | null;
  speciesCode?: string | null;
  bandingCode?: string | null;
};

/** Every name a row can be found by, normalized and joined. Built once per list. */
export function searchHaystack(item: CollectionItem): string {
  const extra = item as CollectionItem & SearchableExtras;
  // Broad groups too, so a search for "raptors" or "frogs" finds every one.
  const parts = [
    item.commonName,
    item.scientificName,
    ...(extra.aliases ?? []),
    ...(extra.codes ?? []),
    extra.speciesCode,
    extra.bandingCode,
    ...broadGroups(item),
  ];
  return parts
    .filter((p): p is string => !!p)
    .map(normalizeSearchText)
    .join("\n");
}

export interface ItemFilters {
  stateFilter: StateFilter;
  ghostOnly: boolean;
  lostOnly: boolean;
  likelyThisMonthOnly: boolean;
  yearFilter: string;
  search: string;
}

export function filterCollectionItems(
  items: CollectionItem[],
  filters: ItemFilters,
  haystacks: Map<string, string>,
  month = new Date().getMonth(),
): CollectionItem[] {
  const { stateFilter, ghostOnly, lostOnly, likelyThisMonthOnly, yearFilter, search } = filters;
  let filtered =
    stateFilter === "all"
      ? items
      : stateFilter === "target"
        ? items.filter((i) => i.isTarget)
        : items.filter((i) => i.state === stateFilter);
  if (ghostOnly) filtered = filtered.filter((i) => i.isGhost);
  if (lostOnly) filtered = filtered.filter((i) => i.isLost);
  if (likelyThisMonthOnly) {
    // Likely = this month holds at least a third of an average month's share of sightings here, so
    // year-round species still count outside their peak.
    filtered = filtered.filter((i) => {
      const months = i.seasonality;
      const total = months?.reduce((sum, v) => sum + v, 0) ?? 0;
      return total > 0 && months![month] / total >= 1 / 36;
    });
  }
  if (yearFilter) {
    const year = Number(yearFilter);
    filtered = filtered.filter((i) => i.capturedYears?.includes(year));
  }
  const query = normalizeSearchText(search);
  if (query) {
    filtered = filtered.filter((i) => (haystacks.get(i.speciesId) ?? searchHaystack(i)).includes(query));
  }
  return filtered;
}
