// Checks for the iNaturalist and GBIF response shapes the pipeline reads, so an odd payload (an
// error page served as 200, a renamed field) fails loudly instead of being written as data or
// cached. Only the fields the pipeline relies on are checked.

type Guard<T> = (v: unknown) => v is T;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isArrayOf = <T>(v: unknown, item: Guard<T>): v is T[] => Array.isArray(v) && v.every(item);

/** The value, typed, or an error naming what was expected. */
export function expectShape<T>(value: unknown, guard: Guard<T>, what: string): T {
  if (!guard(value)) throw new Error(`Unexpected ${what} response: ${JSON.stringify(value)?.slice(0, 200)}`);
  return value;
}

/** iNaturalist /v1/taxa (by id or by search): every result has a numeric id and a name. */
export function isInatTaxaPage(v: unknown): v is { results: Array<{ id: number; name: string }> } {
  return (
    isRecord(v) &&
    isArrayOf(
      v.results,
      (t): t is { id: number; name: string } => isRecord(t) && typeof t.id === "number" && typeof t.name === "string",
    )
  );
}

/** iNaturalist /v1/observations/species_counts. */
export function isInatSpeciesCountsPage(
  v: unknown,
): v is { total_results: number; results: Array<{ count: number; taxon: { id: number; name: string } }> } {
  return (
    isRecord(v) &&
    typeof v.total_results === "number" &&
    isArrayOf(
      v.results,
      (r): r is { count: number; taxon: { id: number; name: string } } =>
        isRecord(r) &&
        typeof r.count === "number" &&
        isRecord(r.taxon) &&
        typeof r.taxon.id === "number" &&
        typeof r.taxon.name === "string",
    )
  );
}

/** iNaturalist places (autocomplete): every result has a numeric id. */
export function isInatPlacesPage(v: unknown): v is { results: Array<{ id: number }> } {
  return isRecord(v) && isArrayOf(v.results, (p): p is { id: number } => isRecord(p) && typeof p.id === "number");
}

/** iNaturalist /v1/places/nearby: the "standard" places, each with a numeric id. */
export function isInatNearbyPlaces(v: unknown): v is { results: { standard: Array<{ id: number }> } } {
  return isRecord(v) && isRecord(v.results) && isInatPlacesPage({ results: v.results.standard });
}

/** GBIF occurrence search with facets: each facet's counts are name/count pairs. */
export function isGbifFacets(
  v: unknown,
): v is { facets: Array<{ field: string; counts: Array<{ name: string; count: number }> }> } {
  return (
    isRecord(v) &&
    isArrayOf(
      v.facets,
      (f): f is { field: string; counts: Array<{ name: string; count: number }> } =>
        isRecord(f) &&
        typeof f.field === "string" &&
        isArrayOf(
          f.counts,
          (c): c is { name: string; count: number } =>
            isRecord(c) && typeof c.name === "string" && typeof c.count === "number",
        ),
    )
  );
}

/** A GBIF search with limit=0: just the total. */
export function isGbifCount(v: unknown): v is { count: number } {
  return isRecord(v) && typeof v.count === "number";
}

/** A GBIF paged list (occurrence or species search, a taxon's children). */
export function isGbifPage(v: unknown): v is { results: Array<Record<string, unknown>>; endOfRecords?: boolean } {
  return (
    isRecord(v) &&
    isArrayOf(v.results, isRecord) &&
    (v.endOfRecords === undefined || typeof v.endOfRecords === "boolean")
  );
}

/** GBIF species/match: always a matchType; a usageKey when something matched. */
export function isGbifMatch(v: unknown): v is { matchType: string; usageKey?: number } {
  return isRecord(v) && typeof v.matchType === "string" && (v.usageKey === undefined || typeof v.usageKey === "number");
}

/** A GBIF list of taxa (species search, a taxon's children): each has a key, name and rank. */
export function isGbifTaxaPage(
  v: unknown,
): v is { results: Array<{ key: number; scientificName: string; rank: string }>; endOfRecords?: boolean } {
  return (
    isGbifPage(v) &&
    v.results.every(
      (t) => typeof t.key === "number" && typeof t.scientificName === "string" && typeof t.rank === "string",
    )
  );
}
