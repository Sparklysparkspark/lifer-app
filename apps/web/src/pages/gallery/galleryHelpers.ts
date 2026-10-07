import { shotDataLine } from "../../lib/shotData";
import { mediaNoun } from "../../lib/mediaNoun";
import i18n from "../../i18n";
import type { GalleryItem, GalleryQuery, SearchInterpretation } from "./types";

// Matches the API's UNCATEGORIZED_REGION_ID sentinel (gallery/routes.ts): captures with no region.
export const UNCATEGORIZED_REGION_ID = "uncategorized";

/** The filters as the API's query string, shared by the listing, search and select-all requests.
 *  The sort isn't here: search results are ranked by relevance, so only the listing adds it. */
export function galleryParams(q: Omit<GalleryQuery, "sortBy">): URLSearchParams {
  const params = new URLSearchParams();
  if (q.searchQuery) params.set("q", q.searchQuery);
  if (q.onlyHidden) params.set("hidden", "1");
  if (q.onlyTopRated) params.set("onlyTopRated", "1");
  if (q.onlyFeatured) params.set("onlyFeatured", "1");
  if (q.missingDate) params.set("missingDate", "1");
  if (q.selectedTaxa.size > 0) params.set("taxa", [...q.selectedTaxa].join(","));
  if (q.rawFilter === "without") params.set("excludeHasRaw", "1");
  if (q.rawFilter === "with") params.set("onlyHasRaw", "1");
  if (q.mediaFilter === "videos") params.set("onlyVideo", "1");
  if (q.mediaFilter === "photos") params.set("excludeVideo", "1");
  if (q.dateFrom) params.set("dateFrom", q.dateFrom);
  if (q.dateTo) params.set("dateTo", q.dateTo);
  if (q.regionId) params.set("regionId", q.regionId);
  if (q.tag) params.set("tag", q.tag);
  if (q.scopeTripId) params.set("tripId", q.scopeTripId);
  if (q.scopeAlbumId) params.set("albumId", q.scopeAlbumId);
  return params;
}

/** For the Filters badge. The RAW and media presets count when off their defaults too: the badge
 *  answers "why am I seeing fewer photos". The search and the missing-date view don't count. */
export function countActiveFilters(q: GalleryQuery): number {
  return (
    (q.onlyHidden ? 1 : 0) +
    (q.onlyTopRated ? 1 : 0) +
    (q.onlyFeatured ? 1 : 0) +
    (q.mediaFilter !== "photos" ? 1 : 0) +
    (q.rawFilter !== "without" ? 1 : 0) +
    (q.selectedTaxa.size > 0 ? 1 : 0) +
    (q.dateFrom || q.dateTo ? 1 : 0) +
    (q.regionId ? 1 : 0) +
    (q.tag ? 1 : 0) +
    (q.scopeTripId ? 1 : 0) +
    (q.scopeAlbumId ? 1 : 0)
  );
}

/** Appends the photos not already present (a page can overlap after a local delete or reload). */
export function appendNew(prev: GalleryItem[], extra: GalleryItem[]): GalleryItem[] {
  if (extra.length === 0) return prev;
  const seen = new Set(prev.map((it) => it.photoId));
  const fresh = extra.filter((it) => !seen.has(it.photoId));
  return fresh.length === 0 ? prev : [...prev, ...fresh];
}

export function anySelectedIn(ids: ReadonlySet<string> | undefined, selected: ReadonlySet<string>): boolean {
  if (!ids) return false;
  for (const id of ids) if (selected.has(id)) return true;
  return false;
}

export function toggleInSet(prev: Set<string>, value: string): Set<string> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** "ducks · Washington · 2024 · looks like “swimming”". Null when there's nothing beyond the query. */
export function describeSearchReading(i: SearchInterpretation | undefined): string | null {
  if (!i) return null;
  const subject = [
    ...i.species.slice(0, 3),
    ...(i.species.length > 3 ? [i18n.t("gallery.searchReading.more", { count: i.species.length - 3 })] : []),
    ...i.groups,
  ];
  const parts = [subject.join(", "), ...i.places, ...i.dates].filter(Boolean);
  if (parts.length === 0) return null;
  if (i.description) parts.push(i18n.t("gallery.searchReading.looksLike", { description: i.description }));
  return parts.join(" · ");
}

export function itemShotData(item: GalleryItem): string | null {
  return shotDataLine({
    camera_model: item.cameraModel,
    lens: item.lens,
    focal_length_mm: item.focalLengthMm,
    aperture: item.aperture,
    shutter: item.shutter,
    iso: item.iso,
  });
}

/** Group key for photos whose region is missing or has no name. Region ids are UUIDs, so it
 *  can't collide with one. */
export const UNKNOWN_REGION_GROUP_KEY = "unknown-region";

/** One group per region, alphabetical, photos with no region or an unnamed one pooled under a
 *  single "Unknown region". `key` is stable and unique (the region id), for React keys. `i` is each
 *  photo's index in `items`, so grouped tiles open and select like ungrouped ones. */
export function groupItemsByRegion(items: GalleryItem[]): Array<{
  key: string;
  label: string;
  entries: Array<{ item: GalleryItem; i: number }>;
}> {
  const buckets = new Map<string, { key: string; label: string; entries: { item: GalleryItem; i: number }[] }>();
  items.forEach((item, i) => {
    const name = item.regionId ? item.regionName?.trim() : undefined;
    const key = name ? item.regionId! : UNKNOWN_REGION_GROUP_KEY;
    if (!buckets.has(key)) buckets.set(key, { key, label: name || i18n.t("gallery.unknownRegion"), entries: [] });
    buckets.get(key)!.entries.push({ item, i });
  });
  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Features or unfeatures `item`. A species has one featured photo, so featuring this one
 *  unfeatures the species' others; unfeaturing touches only this one. */
export function withFeatured(items: GalleryItem[], item: GalleryItem, featuring: boolean): GalleryItem[] {
  return items.map((it) =>
    it.speciesId !== item.speciesId
      ? it
      : {
          ...it,
          isFeatured: featuring ? it.photoId === item.photoId : it.photoId === item.photoId ? false : it.isFeatured,
        },
  );
}

/** The line under the Gallery heading: how many photos, and for a search, how it was read. */
export function galleryCountText({
  missingDate,
  loadedCount,
  nextCursor,
  total,
  searchQuery,
  searchReading,
}: {
  missingDate: boolean;
  loadedCount: number;
  nextCursor: string | null;
  total: number | null;
  searchQuery: string;
  searchReading: string | null;
}): string {
  if (missingDate) {
    return nextCursor
      ? i18n.t("gallery.count.missingDateAtLeast", { count: loadedCount })
      : i18n.t("gallery.count.missingDate", { count: loadedCount });
  }
  if (nextCursor && total !== null) return i18n.t("gallery.count.photos", { count: total });
  if (nextCursor) return i18n.t("gallery.count.loadedMore", { count: loadedCount });
  if (!searchQuery) return i18n.t("gallery.count.photos", { count: loadedCount });
  return searchReading
    ? i18n.t("gallery.count.matchingRead", { count: loadedCount, query: searchQuery, reading: searchReading })
    : i18n.t("gallery.count.matching", { count: loadedCount, query: searchQuery });
}

/** "photo", "video" or "file" for the selection. `moreVideoIds` lists videos selected by a select
 *  all that aren't loaded yet. */
export function selectionNoun(
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  moreVideoIds: Iterable<string> = [],
): "file" | "video" | "photo" {
  const selectedVideos = new Set<string>();
  for (const it of items) if (it.kind === "video" && selected.has(it.captureId)) selectedVideos.add(it.captureId);
  for (const id of moreVideoIds) if (selected.has(id)) selectedVideos.add(id);
  return mediaNoun(selectedVideos.size > 0, selected.size > selectedVideos.size);
}

/** Whether any selected photo has a RAW, loaded or (from a select all) not. */
export function selectionHasRaw(
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  moreRawIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    selected.size > 0 &&
    (items.some((it) => selected.has(it.captureId) && it.hasRawOriginal) || anySelectedIn(moreRawIds, selected))
  );
}
