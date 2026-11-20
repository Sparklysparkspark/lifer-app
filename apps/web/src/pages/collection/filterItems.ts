import { nameMatchScore, type CollectionItem } from "@lifer/shared";
import type { PhotosTakenFilter, StateFilter, TraitFilter } from "./useCollectionUrlState";
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

/** Every name a row can be found by, normalized and joined. Built once per list. English names
 *  come first; after a blank line, the scientific name and codes, which only match from a word
 *  start (nameMatchScore's prefixOnly). */
export function searchHaystack(item: CollectionItem): string {
  const extra = item as CollectionItem & SearchableExtras;
  const join = (parts: Array<string | null | undefined>) =>
    parts
      .filter((p): p is string => !!p)
      .map(normalizeSearchText)
      .join("\n");
  // Broad groups too, so a search for "raptors" or "frogs" finds every one.
  const names = join([item.commonName, ...(extra.aliases ?? []), ...broadGroups(item)]);
  const prefixOnly = join([item.scientificName, ...(extra.codes ?? []), extra.speciesCode, extra.bandingCode]);
  return `${names}\n\n${prefixOnly}`;
}

export interface ItemFilters {
  stateFilter: StateFilter;
  introduced: TraitFilter;
  endemic: TraitFilter;
  vagrant: TraitFilter;
  /** Narrows photographed species by where their photos were taken; only region rows carry the flag. */
  photosTaken?: PhotosTakenFilter;
  /** Tiers to keep, matched against the tier the card shows; empty keeps every tier. */
  tiers: ReadonlySet<string>;
  ghostOnly: boolean;
  lostOnly: boolean;
  /** Only species marked "needs a better photo". */
  needsBetterOnly?: boolean;
  likelyThisMonthOnly: boolean;
  yearFilter: string;
  search: string;
  /** Taxon classes to keep; empty or absent keeps all. The Collection asks the server instead. */
  taxa?: ReadonlySet<string>;
  /** With the Targets filter, only the targets on this one target list. */
  targetListSpecies?: ReadonlySet<string> | null;
}

export function filterCollectionItems(
  items: CollectionItem[],
  filters: ItemFilters,
  haystacks: Map<string, string>,
  month = new Date().getMonth(),
): CollectionItem[] {
  const {
    stateFilter,
    introduced,
    endemic,
    vagrant,
    photosTaken = "anywhere",
    tiers,
    ghostOnly,
    lostOnly,
    needsBetterOnly,
    likelyThisMonthOnly,
    yearFilter,
    search,
    taxa,
    targetListSpecies,
  } = filters;
  let filtered =
    stateFilter === "all"
      ? items
      : stateFilter === "target"
        ? items.filter((i) => i.isTarget && (!targetListSpecies || targetListSpecies.has(i.speciesId)))
        : items.filter((i) => i.state === stateFilter);
  if (taxa?.size) filtered = filtered.filter((i) => !!i.taxonClass && taxa.has(i.taxonClass));
  filtered = byTrait(filtered, introduced, (i) => i.introduced);
  filtered = byTrait(filtered, endemic, (i) => i.endemic);
  filtered = byTrait(filtered, vagrant, (i) => i.vagrant);
  // Species without a photo stay with the Show filter; rows without the flag (no region) aren't narrowed.
  // A photographed species whose photos have no place at all is neither here nor elsewhere.
  if (photosTaken !== "anywhere") {
    filtered = filtered.filter(
      (i) => i.state !== "collected" || i.photographedWhere === undefined || i.photographedWhere === photosTaken,
    );
  }
  // localTier is only set on a region's rows, where it's the tier the card shows.
  if (tiers.size > 0) filtered = filtered.filter((i) => tiers.has(i.localTier ?? i.tier ?? "unrated"));
  if (ghostOnly) filtered = filtered.filter((i) => i.isGhost);
  if (lostOnly) filtered = filtered.filter((i) => i.isLost);
  if (needsBetterOnly) filtered = filtered.filter((i) => i.needsBetterPhoto);
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
  if (query) filtered = filtered.filter((i) => searchScore(i, query, haystacks) >= 0);
  return filtered;
}

// The Gallery's word rules: every word fits the same name, so "pil" skips atricaPILlus.
function searchScore(item: CollectionItem, query: string, haystacks: Map<string, string>): number {
  const [names, prefixOnly = ""] = (haystacks.get(item.speciesId) ?? searchHaystack(item)).split("\n\n");
  return nameMatchScore(names.split("\n"), query, prefixOnly.split("\n"));
}

/** How well each species fits the search (nameMatchScore, higher first), for ranking the list;
 *  null with no search, so the sort control's order applies untouched. */
export function searchRanks(
  items: CollectionItem[],
  search: string,
  haystacks: Map<string, string>,
): Map<string, number> | null {
  const query = normalizeSearchText(search);
  if (!query) return null;
  return new Map(items.map((i) => [i.speciesId, searchScore(i, query, haystacks)]));
}

/** Best matches first; Array.sort is stable, so equal matches keep the order they came in. */
export function rankBySearch(items: CollectionItem[], ranks: ReadonlyMap<string, number> | null | undefined) {
  if (!ranks) return items;
  return [...items].sort((a, b) => (ranks.get(b.speciesId) ?? -1) - (ranks.get(a.speciesId) ?? -1));
}

function byTrait(
  items: CollectionItem[],
  filter: TraitFilter,
  has: (item: CollectionItem) => boolean,
): CollectionItem[] {
  return filter === "any" ? items : items.filter((i) => has(i) === (filter === "only"));
}
