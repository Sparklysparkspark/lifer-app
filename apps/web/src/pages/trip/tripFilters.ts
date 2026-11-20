import { matchesPhotoFilters, sortPhotos, type PhotoFilters, type PhotoSort } from "../../lib/photoListFilters";
import { orderGroupKeys, speciesGroupKey, type SpeciesGroupBy } from "../../lib/speciesGrouping";
import { tierLabel } from "../../lib/speciesGroups";
import { TAXON_LABEL } from "../collection/taxonLabels";
import type { TripPhoto } from "./types";

interface Named {
  commonName: string | null;
  scientificName: string;
}

// `query` is already trimmed and lowercased.
function nameMatches(item: Named, query: string): boolean {
  return (item.commonName ?? "").toLowerCase().includes(query) || item.scientificName.toLowerCase().includes(query);
}

/** The trip's photo grid: the search box (by species name), the Filters panel and its species
 *  picker (empty keeps every species), then the sort. */
export function visibleTripPhotos(
  photos: TripPhoto[],
  search: string,
  filters: PhotoFilters,
  sortBy: PhotoSort,
  speciesIds: ReadonlySet<string> = new Set(),
): TripPhoto[] {
  const query = search.trim().toLowerCase();
  return sortPhotos(
    photos.filter(
      (p) =>
        (speciesIds.size === 0 || speciesIds.has(p.speciesId)) &&
        (!query || nameMatches(p, query)) &&
        matchesPhotoFilters(p, { hasRaw: p.hasRaw, rawOnly: p.originalKind === "raw" }, filters),
    ),
    sortBy,
  );
}

/** The photo view's Group choices: by species, or the Collection's species groupings. */
export type TripPhotoGroupBy = "none" | "species" | Exclude<SpeciesGroupBy, "localTier">;
export const TRIP_PHOTO_GROUPS: readonly TripPhotoGroupBy[] = ["none", "species", "broad", "group", "tier"];

/** The photos in grid order and their groups (null when ungrouped). Species groups follow the
 *  sort (each where its first photo is); the others follow the Collection's order. Photos keep
 *  their order within a group, and `photos` is reordered to match so Shift ranges and the
 *  lightbox follow what's on screen. */
export function groupTripPhotos(
  sorted: TripPhoto[],
  groupBy: TripPhotoGroupBy,
  speciesName: (p: TripPhoto) => string,
  namingStyles?: string[],
): {
  photos: TripPhoto[];
  groups: Array<{ key: string; label: string; entries: Array<{ item: TripPhoto; i: number }> }> | null;
} {
  if (groupBy === "none") return { photos: sorted, groups: null };
  const byKey = new Map<string, TripPhoto[]>();
  const labels = new Map<string, string>();
  for (const p of sorted) {
    const key = groupBy === "species" ? p.speciesId : speciesGroupKey(p, groupBy, namingStyles);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      labels.set(key, groupBy === "species" ? speciesName(p) : groupBy === "tier" ? tierLabel(key) : key);
    }
    byKey.get(key)!.push(p);
  }
  const keys =
    groupBy === "species" ? [...byKey.keys()] : orderGroupKeys([...byKey.keys()], groupBy, (k) => byKey.get(k)!);
  const photos: TripPhoto[] = [];
  const groups = keys.map((key) => ({
    key,
    label: labels.get(key)!,
    entries: byKey.get(key)!.map((item) => ({ item, i: photos.push(item) - 1 })),
  }));
  return { photos, groups };
}

/** The species view's Animals choices: the taxon classes the trip has, in the Collection's order. */
export function tripTaxonFilters(items: ReadonlyArray<{ taxonClass: string | null }>): string[] {
  const order = Object.keys(TAXON_LABEL);
  const rank = (tc: string) => (order.includes(tc) ? order.indexOf(tc) : order.length);
  const present = new Set(items.map((i) => i.taxonClass).filter((tc): tc is string => !!tc));
  return [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
