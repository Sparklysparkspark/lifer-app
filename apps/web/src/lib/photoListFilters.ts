// Sorting and filtering for photo grids that load every photo at once (a trip, an album), so the
// work happens here rather than on the server as it does for the Gallery.

export type PhotoSort = "newest" | "oldest" | "ratingHigh" | "ratingLow";
export type RawFilter = "any" | "with" | "without";
export type MediaFilter = "both" | "photos" | "videos";

export interface PhotoFilters {
  rawFilter: RawFilter;
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

/** A photo with no date passes the date range: there's nothing to rule it out. */
export function matchesPhotoFilters(photo: SortablePhoto, hasRaw: boolean, filters: PhotoFilters): boolean {
  const { rawFilter, onlyTopRated, dateFrom, dateTo } = filters;
  return (
    (rawFilter === "any" || (rawFilter === "with" ? hasRaw : !hasRaw)) &&
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

/** For the Filters badge. The RAW filter counts only off its default ("without"). */
export function countPhotoFilters({ rawFilter, onlyTopRated, dateFrom, dateTo }: PhotoFilters): number {
  return (onlyTopRated ? 1 : 0) + (rawFilter !== "without" ? 1 : 0) + (dateFrom || dateTo ? 1 : 0);
}
