// Sorting and filtering for photo grids that load every photo at once (a trip, an album), so the
// work happens here rather than on the server as it does for the Gallery.

export type PhotoSort = "newest" | "oldest" | "ratingHigh" | "ratingLow";
/** RAW-only photos (a RAW with no edited original beside it): shown, hidden, or the only ones. */
export type RawFilesFilter = "show" | "hide" | "only";
/** Photo grids open on the edited photos; RAW-only ones are a filter away. */
export const DEFAULT_RAW_FILES: RawFilesFilter = "hide";
/** Edited photos, by whether their RAW was imported with them. RAW-only photos always pass. */
export type EditedRawFilter = "any" | "with" | "without";
export type MediaFilter = "both" | "photos" | "videos";

export interface PhotoFilters {
  rawFiles: RawFilesFilter;
  editedRaw: EditedRawFilter;
  onlyTopRated: boolean;
  /** YYYY-MM-DD, or "" for no bound. dateTo is inclusive. */
  dateFrom: string;
  dateTo: string;
}

// Optional because an album photo's metadata is (see AlbumPhoto); missing counts as unknown.
interface SortablePhoto {
  takenAt?: string | null;
  qualityRating?: number | null;
}

/** The Gallery API's query parameters for the two RAW filters (shared with the search palette). */
export function rawFilterParams(rawFiles: RawFilesFilter, editedRaw: EditedRawFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (rawFiles === "hide") out.includeRaw = "0";
  if (rawFiles === "only") out.onlyRaw = "1";
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
  const { rawFiles, editedRaw, onlyTopRated, dateFrom, dateTo } = filters;
  return (
    (rawFiles === "show" || (rawFiles === "hide" ? !raw.rawOnly : raw.rawOnly)) &&
    (raw.rawOnly || editedRaw === "any" || (editedRaw === "with" ? raw.hasRaw : !raw.hasRaw)) &&
    (!onlyTopRated || photo.qualityRating === 5) &&
    (!dateFrom || !photo.takenAt || photo.takenAt >= dateFrom) &&
    (!dateTo || !photo.takenAt || photo.takenAt <= `${dateTo}T23:59:59`)
  );
}

export function matchesMediaFilter(kind: "image" | "video" | undefined, mediaFilter: MediaFilter): boolean {
  return mediaFilter === "both" || (mediaFilter === "videos" ? kind === "video" : kind !== "video");
}

/** "newest" keeps the server's order (the same array). Unrated sorts as a 3, as in the Gallery. */
export function sortPhotos<T extends SortablePhoto>(photos: T[], sortBy: PhotoSort): T[] {
  if (sortBy === "newest") return photos;
  return [...photos].sort((a, b) => {
    if (sortBy === "oldest") {
      return (a.takenAt ? new Date(a.takenAt).getTime() : 0) - (b.takenAt ? new Date(b.takenAt).getTime() : 0);
    }
    const ratingA = a.qualityRating ?? 3;
    const ratingB = b.qualityRating ?? 3;
    return sortBy === "ratingHigh" ? ratingB - ratingA : ratingA - ratingB;
  });
}

/** For the Filters badge: each RAW filter counts once off its default. */
export function countPhotoFilters({ rawFiles, editedRaw, onlyTopRated, dateFrom, dateTo }: PhotoFilters): number {
  return (
    (onlyTopRated ? 1 : 0) +
    (rawFiles !== DEFAULT_RAW_FILES ? 1 : 0) +
    (editedRaw !== "any" ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0)
  );
}
