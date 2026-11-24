// Sorting and filtering for photo grids that load every photo at once (a trip, an album). The
// filters a loaded photo can answer run here; the rest go to /gallery/ids (useScopedFilterIds).

import { TIER_ORDER, compareFieldGuideOrder } from "@lifer/shared";

/** The Gallery API's sort names; the last four are the Collection's species orders. */
export type PhotoSort =
  "newest" | "oldest" | "ratingHigh" | "ratingLow" | "taxonomic" | "name" | "scientific" | "rarity";
/** RAW-only photos (a RAW with no edited original beside it): shown, hidden, or the only ones.
 *  "unedited" is the editing backlog: only RAWs with no edited version, linked ones included. */
export type RawFilesFilter = "show" | "hide" | "only" | "unedited";
/** A RAW-only photo is the user's only copy, so grids show it; a RAW with an edited copy is one photo already. */
export const DEFAULT_RAW_FILES: RawFilesFilter = "show";
/** Edited photos, by whether their RAW was imported with them. RAW-only photos always pass. */
export type EditedRawFilter = "any" | "with" | "without";
export type MediaFilter = "both" | "photos" | "videos" | "recordings";

/** The Gallery's filters a loaded photo can answer, with the same meaning as the server's. */
export interface PhotoFilters {
  rawFiles: RawFilesFilter;
  editedRaw: EditedRawFilter;
  /** Star range, both ends inclusive; unrated photos never match a range. */
  ratingMin: number | null;
  ratingMax: number | null;
  unrated: boolean;
  missingDate: boolean;
  /** YYYY-MM-DD, or "" for no bound. dateTo is inclusive. */
  dateFrom: string;
  dateTo: string;
}

// Optional because an album photo's metadata is (see AlbumPhoto); missing counts as unknown.
interface SortablePhoto {
  takenAt?: string | null;
  qualityRating?: number | null;
  commonName?: string | null;
  scientificName?: string;
  taxonClass?: string | null;
  taxonOrder?: string | null;
  family?: string | null;
  sortOrder?: number | null;
  tier?: string | null;
}

/** The Gallery API's query parameters for the two RAW filters (shared with the search palette). */
export function rawFilterParams(rawFiles: RawFilesFilter, editedRaw: EditedRawFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (rawFiles === "hide") out.includeRaw = "0";
  if (rawFiles === "only") out.onlyRaw = "1";
  if (rawFiles === "unedited") out.unedited = "1";
  if (editedRaw === "with") out.onlyHasRaw = "1";
  if (editedRaw === "without") out.excludeHasRaw = "1";
  return out;
}

/** What a photo's originals are: whether it has a RAW, and whether the RAW is all it has. */
export interface PhotoRaw {
  hasRaw: boolean;
  rawOnly: boolean;
}

/** A photo with no date passes the date range: there's nothing to rule it out. */
export function matchesPhotoFilters(photo: SortablePhoto, raw: PhotoRaw, filters: PhotoFilters): boolean {
  const { rawFiles, editedRaw, ratingMin, ratingMax, unrated, missingDate, dateFrom, dateTo } = filters;
  const rating = photo.qualityRating ?? null;
  return (
    (rawFiles === "show" || (rawFiles === "hide" ? !raw.rawOnly : raw.rawOnly)) &&
    (raw.rawOnly || editedRaw === "any" || (editedRaw === "with" ? raw.hasRaw : !raw.hasRaw)) &&
    (!unrated || rating === null) &&
    (ratingMin === null || (rating !== null && rating >= ratingMin)) &&
    (ratingMax === null || (rating !== null && rating <= ratingMax)) &&
    (!missingDate || !photo.takenAt) &&
    (!dateFrom || !photo.takenAt || photo.takenAt >= dateFrom) &&
    (!dateTo || !photo.takenAt || photo.takenAt <= `${dateTo}T23:59:59`)
  );
}

export function matchesMediaFilter(kind: "image" | "video" | "audio" | undefined, mediaFilter: MediaFilter): boolean {
  if (mediaFilter === "both") return true;
  if (mediaFilter === "videos") return kind === "video";
  if (mediaFilter === "recordings") return kind === "audio";
  return kind !== "video" && kind !== "audio";
}

// The Gallery API's species orders (gallery/routes.ts GALLERY_SORTS), for grids sorted here.
const time = (p: SortablePhoto) => (p.takenAt ? new Date(p.takenAt).getTime() : null);
// Undated last; two undated give NaN, read as a tie.
const newestFirst = (a: SortablePhoto, b: SortablePhoto) => (time(b) ?? -Infinity) - (time(a) ?? -Infinity) || 0;
const fieldGuide = (a: SortablePhoto, b: SortablePhoto) =>
  (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
  compareFieldGuideOrder(a, b) ||
  (a.scientificName ?? "").localeCompare(b.scientificName ?? "");
// A sort key, not a shown name: the catalog's common name, as the server sorts by.
const nameKey = (p: SortablePhoto) => (p.commonName ? p.commonName : (p.scientificName ?? ""));
// Rarest first, as search ranks it: legendary highest, unknown last.
const tierRank = (p: SortablePhoto) => (TIER_ORDER as readonly string[]).indexOf(p.tier ?? "") + 1;
const SPECIES_SORTS: Partial<Record<PhotoSort, (a: SortablePhoto, b: SortablePhoto) => number>> = {
  taxonomic: (a, b) => fieldGuide(a, b) || newestFirst(a, b),
  name: (a, b) =>
    nameKey(a).localeCompare(nameKey(b)) ||
    (a.scientificName ?? "").localeCompare(b.scientificName ?? "") ||
    newestFirst(a, b),
  scientific: (a, b) => (a.scientificName ?? "").localeCompare(b.scientificName ?? "") || newestFirst(a, b),
  rarity: (a, b) => tierRank(b) - tierRank(a) || fieldGuide(a, b) || newestFirst(a, b),
};

/** "newest" keeps the server's order (the same array). Unrated sorts as a 3, as in the Gallery. */
export function sortPhotos<T extends SortablePhoto>(photos: T[], sortBy: PhotoSort): T[] {
  if (sortBy === "newest") return photos;
  const bySpecies = SPECIES_SORTS[sortBy];
  return [...photos].sort((a, b) => {
    if (bySpecies) return bySpecies(a, b);
    if (sortBy === "oldest") {
      return (a.takenAt ? new Date(a.takenAt).getTime() : 0) - (b.takenAt ? new Date(b.takenAt).getTime() : 0);
    }
    const ratingA = a.qualityRating ?? 3;
    const ratingB = b.qualityRating ?? 3;
    return sortBy === "ratingHigh" ? ratingB - ratingA : ratingA - ratingB;
  });
}
