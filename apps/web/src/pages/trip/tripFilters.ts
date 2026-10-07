import { matchesPhotoFilters, sortPhotos, type PhotoFilters, type PhotoSort } from "../../lib/photoListFilters";
import type { TripPhoto } from "./types";

interface Named {
  commonName: string | null;
  scientificName: string;
}

// `query` is already trimmed and lowercased.
function nameMatches(item: Named, query: string): boolean {
  return (item.commonName ?? "").toLowerCase().includes(query) || item.scientificName.toLowerCase().includes(query);
}

/** The trip's photo grid: the search box (by species name), the Filters panel, then the sort. */
export function visibleTripPhotos(
  photos: TripPhoto[],
  search: string,
  filters: PhotoFilters,
  sortBy: PhotoSort,
): TripPhoto[] {
  const query = search.trim().toLowerCase();
  return sortPhotos(
    photos.filter((p) => (!query || nameMatches(p, query)) && matchesPhotoFilters(p, p.hasRaw, filters)),
    sortBy,
  );
}

/** The species view: only the search box applies. With no search, the same array comes back. */
export function visibleTripSpecies<T extends Named>(items: T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => nameMatches(item, query));
}
