import i18n from "../../i18n";
import { mediaNoun } from "../../lib/mediaNoun";
import { filterBucketFor, type PhotoFilter, type SpeciesCapture } from "./types";

export type PhotoSort = "newest" | "oldest" | "rating";

function takenTime(c: SpeciesCapture): number {
  return c.taken_at ? new Date(c.taken_at).getTime() : 0;
}

/** "newest" is the server's own order, so it returns the same array. */
export function sortCaptures(captures: SpeciesCapture[], sort: PhotoSort): SpeciesCapture[] {
  if (sort === "newest") return captures;
  return [...captures].sort((a, b) =>
    // Unrated sinks below a genuine 1-star rather than counting as 0.
    sort === "oldest" ? takenTime(a) - takenTime(b) : (b.quality_rating ?? -1) - (a.quality_rating ?? -1),
  );
}

export function matchesFilter(c: SpeciesCapture, filter: PhotoFilter): boolean {
  return filter === "all" || filterBucketFor(c) === filter;
}

/** "Prince George, British Columbia", or whichever half is set. */
export function locationText(c: SpeciesCapture): string | null {
  if (c.location_label && c.region_name) {
    return i18n.t("species.photos.placeInRegion", { place: c.location_label, region: c.region_name });
  }
  return c.location_label ?? c.region_name;
}

/** How many of each kind the filter pills offer. Captures without a photo count as none. */
export function captureCounts(captures: SpeciesCapture[]): { edited: number; raw: number; video: number } {
  let edited = 0;
  let raw = 0;
  let video = 0;
  for (const c of captures) {
    if (c.photo_kind === "video") video++;
    else if (!c.photo_id) continue;
    else if (c.original_kind === "raw") raw++;
    else edited++;
  }
  return { edited, raw, video };
}

export function photosSectionTitle(filter: PhotoFilter, counts: { edited: number; raw: number; video: number }) {
  const hasPhotos = counts.edited + counts.raw > 0;
  const hasVideos = counts.video > 0;
  return filter === "video"
    ? i18n.t("species.photos.yourVideos")
    : filter !== "all"
      ? i18n.t("species.photos.yourPhotos")
      : hasPhotos && hasVideos
        ? i18n.t("species.photos.yourPhotosAndVideos")
        : hasVideos
          ? i18n.t("species.photos.yourVideos")
          : i18n.t("species.photos.yourPhotos");
}

export function deleteNoun(selected: SpeciesCapture[]): "file" | "video" | "photo" {
  return mediaNoun(
    selected.some((c) => c.photo_kind === "video"),
    selected.some((c) => c.photo_kind !== "video"),
  );
}
