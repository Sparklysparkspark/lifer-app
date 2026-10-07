import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { GroupBy, SortBy } from "../../components/GroupedSpeciesGrid";

export type StateFilter = "all" | "collected" | "seen" | "target" | "unseen";
export type ParamUpdates = Record<string, string | null>;
export type UpdateParams = (updates: ParamUpdates, options?: { replace?: boolean }) => void;

// Every filter, sort and group choice lives in the URL so a view survives region changes and
// back-navigation and stays bookmarkable.
export function useCollectionUrlState() {
  const [searchParams, setSearchParams] = useSearchParams();

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

  return {
    regionId,
    taxonRaw,
    taxonFilters,
    // Pack prompts and sea-zone relevance only apply to exactly one taxon.
    singleTaxonFilter: taxonFilters.size === 1 ? [...taxonFilters][0] : undefined,
    seaZoneIds,
    includeLand: searchParams.get("includeLand") !== "0",
    sortBy: (searchParams.get("sort") as SortBy) || "taxonomic",
    groupBy: (searchParams.get("group") as GroupBy) || "none",
    // No param means collectedFirst on, the others off; toggling writes an explicit value.
    collectedFirst: searchParams.get("collectedFirst") !== "0",
    seenFirst: searchParams.get("seenFirst") === "1",
    targetFirst: searchParams.get("targetFirst") === "1",
    stateFilter: (searchParams.get("show") as StateFilter) || "all",
    ghostOnly: searchParams.get("ghostOnly") === "1",
    lostOnly: searchParams.get("lostOnly") === "1",
    likelyThisMonthOnly: searchParams.get("likelyThisMonth") === "1",
    // A calendar year the species must have a real capture in; empty means any year.
    yearFilter: searchParams.get("year") || "",
    search,
    setSearch,
    updateParam,
    updateParams,
  };
}

export type CollectionUrlState = ReturnType<typeof useCollectionUrlState>;
