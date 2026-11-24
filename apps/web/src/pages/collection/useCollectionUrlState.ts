import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParamsKeepingState } from "../../hooks/useSearchParamsKeepingState";
import type { GroupBy, SortBy } from "../../components/GroupedSpeciesGrid";
import type { ItemFilters } from "./filterItems";
import { parseEnum } from "../../lib/parseEnum";

const SORT_BY_VALUES: readonly SortBy[] = ["taxonomic", "name", "scientific", "rarity", "localRarity"];
const GROUP_BY_VALUES: readonly GroupBy[] = ["none", "broad", "group", "tier", "localTier"];
const STATE_FILTERS = ["all", "collected", "seen", "target", "unseen"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
// For a yes-or-no trait (introduced, endemic, vagrant): no filter, only those, or none of them.
const TRAIT_FILTERS = ["any", "only", "hide"] as const;
export type TraitFilter = (typeof TRAIT_FILTERS)[number];
// Where the photos of a photographed species were taken, relative to the viewed region.
const PHOTOS_TAKEN_FILTERS = ["anywhere", "here", "elsewhere"] as const;
export type PhotosTakenFilter = (typeof PHOTOS_TAKEN_FILTERS)[number];
export type ParamUpdates = Record<string, string | null>;
export type UpdateParams = (updates: ParamUpdates, options?: { replace?: boolean }) => void;

// Every filter, sort and group choice lives in the URL so a view survives region changes and
// back-navigation and stays bookmarkable. Also the trip page's species view, whose back link
// names where it came from, so changes keep the entry's location state.
export function useCollectionUrlState() {
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();

  // One functional update per change: two setSearchParams calls in the same tick each start
  // from the same snapshot and the second overwrites the first.
  const updateParams = useCallback<UpdateParams>(
    (updates, options) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(updates)) {
          if (value === null || value === "") next.delete(key);
          else next.set(key, value);
        }
        return next;
      }, options);
    },
    [setSearchParams],
  );
  const updateParam = useCallback(
    (key: string, value: string | null, options?: { replace?: boolean }) => updateParams({ [key]: value }, options),
    [updateParams],
  );

  const regionId = searchParams.get("region");
  // Memoized on the raw strings so an unrelated URL change (a search keystroke) keeps the same
  // Set/array and doesn't refetch the checklist.
  const taxonRaw = searchParams.get("taxon") ?? "";
  const taxonFilters = useMemo(() => new Set(taxonRaw.split(",").filter(Boolean)), [taxonRaw]);
  const tiersRaw = searchParams.get("tiers") ?? "";
  const tierFilters = useMemo(() => new Set(tiersRaw.split(",").filter(Boolean)), [tiersRaw]);
  const seaZonesRaw = searchParams.get("seaZones") ?? "";
  const seaZoneIds = useMemo(() => seaZonesRaw.split(",").filter(Boolean), [seaZonesRaw]);

  const search = searchParams.get("search") ?? "";
  // replace: one history entry per keystroke would make Back step through the typing.
  const setSearch = useCallback(
    (value: string) => updateParam("search", value || null, { replace: true }),
    [updateParam],
  );

  // A search or sea zone picked for one region means nothing in another. Only on a real change,
  // so a bookmarked ?region=X&search=Y still works on first load.
  const prevRegionId = useRef(regionId);
  useEffect(() => {
    if (prevRegionId.current !== regionId)
      updateParams({ search: null, seaZones: null, includeLand: null }, { replace: true });
    prevRegionId.current = regionId;
  }, [regionId, updateParams]);

  const stateFilter = parseEnum(searchParams.get("show"), STATE_FILTERS, "all");
  // One target list the Targets filter narrows to; none means every target.
  const targetListId = searchParams.get("targetList");
  const ghostOnly = searchParams.get("ghostOnly") === "1";
  const lostOnly = searchParams.get("lostOnly") === "1";
  const needsBetterOnly = searchParams.get("needsBetter") === "1";
  const rawOnlyOnly = searchParams.get("rawOnly") === "1";
  const likelyThisMonthOnly = searchParams.get("likelyThisMonth") === "1";
  // A calendar year the species must have a real capture in; empty means any year.
  const yearFilter = searchParams.get("year") || "";
  const introducedFilter = parseEnum(searchParams.get("introduced"), TRAIT_FILTERS, "any");
  const endemicFilter = parseEnum(searchParams.get("endemic"), TRAIT_FILTERS, "any");
  const vagrantFilter = parseEnum(searchParams.get("vagrant"), TRAIT_FILTERS, "any");
  const photosTakenFilter = parseEnum(searchParams.get("photosTaken"), PHOTOS_TAKEN_FILTERS, "anywhere");
  // filterCollectionItems' input, the same object until one of these changes.
  const itemFilters = useMemo<ItemFilters>(
    () => ({
      stateFilter,
      introduced: introducedFilter,
      endemic: endemicFilter,
      vagrant: vagrantFilter,
      photosTaken: photosTakenFilter,
      tiers: tierFilters,
      ghostOnly,
      lostOnly,
      needsBetterOnly,
      rawOnlyOnly,
      likelyThisMonthOnly,
      yearFilter,
      search,
    }),
    [
      stateFilter,
      introducedFilter,
      endemicFilter,
      vagrantFilter,
      photosTakenFilter,
      tierFilters,
      ghostOnly,
      lostOnly,
      needsBetterOnly,
      rawOnlyOnly,
      likelyThisMonthOnly,
      yearFilter,
      search,
    ],
  );
  // Every list filter back to "show all", Animals and sea zones included, since those can empty
  // the list too; the region, sort and grouping stay. `also` joins the
  // same write, since a second write in the same tick would undo this one.
  const clearFilters = useCallback(
    (also: ParamUpdates = {}) =>
      updateParams({
        show: null,
        targetList: null,
        ghostOnly: null,
        lostOnly: null,
        needsBetter: null,
        rawOnly: null,
        likelyThisMonth: null,
        year: null,
        introduced: null,
        endemic: null,
        vagrant: null,
        photosTaken: null,
        tiers: null,
        search: null,
        taxon: null,
        seaZones: null,
        includeLand: null,
        ...also,
      }),
    [updateParams],
  );

  return {
    regionId,
    taxonRaw,
    taxonFilters,
    // Pack prompts and sea-zone relevance only apply to exactly one taxon.
    singleTaxonFilter: taxonFilters.size === 1 ? [...taxonFilters][0] : undefined,
    seaZoneIds,
    includeLand: searchParams.get("includeLand") !== "0",
    sortBy: parseEnum(searchParams.get("sort"), SORT_BY_VALUES, "taxonomic"),
    groupBy: parseEnum(searchParams.get("group"), GROUP_BY_VALUES, "none"),
    // No param means collectedFirst on, the others off; toggling writes an explicit value.
    collectedFirst: searchParams.get("collectedFirst") !== "0",
    seenFirst: searchParams.get("seenFirst") === "1",
    targetFirst: searchParams.get("targetFirst") === "1",
    stateFilter,
    targetListId,
    ghostOnly,
    lostOnly,
    needsBetterOnly,
    rawOnlyOnly,
    likelyThisMonthOnly,
    yearFilter,
    introducedFilter,
    endemicFilter,
    vagrantFilter,
    photosTakenFilter,
    // Rarity tiers to show (the tier each card shows); empty means every tier.
    tierFilters,
    search,
    setSearch,
    itemFilters,
    clearFilters,
    updateParam,
    updateParams,
  };
}

export type CollectionUrlState = ReturnType<typeof useCollectionUrlState>;
