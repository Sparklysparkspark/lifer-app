import { shotDataLine } from "../../lib/shotData";
import { mediaNoun } from "../../lib/mediaNoun";
import { DEFAULT_RAW_FILES, rawFilterParams, type MediaFilter } from "../../lib/photoListFilters";
import i18n from "../../i18n";
import type { GalleryItem, GalleryQuery, SearchInterpretation } from "./types";
import { formatList } from "../../lib/format";
import { groupInto } from "../../lib/groupInto";
import { tierLabel } from "../../lib/speciesGroups";
import { orderGroupKeys, speciesGroupKey, type SpeciesGroupBy } from "../../lib/speciesGrouping";
import {
  LEGACY_SHOT_KINDS,
  SHOT_ACTIONS,
  SHOT_FRAMINGS,
  type LegacyShotKind,
  type ShotAction,
  type ShotFraming,
} from "@lifer/shared";

// Matches the API's UNCATEGORIZED_REGION_ID sentinel (gallery/routes.ts): captures with no region.
export const UNCATEGORIZED_REGION_ID = "uncategorized";

// Shot type's two axes (stats/shotKinds.ts), in Stats' order.
export const SHOT_ACTION_LABELS: Record<ShotAction, string> = {
  flying: "gallery.shotType.flying",
  behavior: "gallery.shotType.behavior",
  resting: "gallery.shotType.resting",
};
export const SHOT_FRAMING_LABELS: Record<ShotFraming, string> = {
  close: "gallery.shotType.close",
  environmental: "gallery.shotType.environmental",
};

/** A shot type filter's values, in the axis' own order (so equal choices give equal params). */
export function shotTypeValues<T extends string>(chosen: ReadonlySet<string>, known: readonly T[]): T[] {
  return known.filter((k) => chosen.has(k));
}

/** The filters as the API's query string, shared by the listing, search and select-all requests.
 *  The sort isn't here: search results are ranked by relevance, so only the listing adds it. */
export function galleryParams(q: Omit<GalleryQuery, "sortBy">): URLSearchParams {
  // A similar group is shown whole; the other filters wait until it's closed.
  if (q.similarTo) return new URLSearchParams({ similarTo: q.similarTo });
  const params = new URLSearchParams();
  if (q.searchQuery) params.set("q", q.searchQuery);
  if (q.onlyHidden) params.set("hidden", "1");
  if (q.ratingMin) params.set("ratingMin", String(q.ratingMin));
  if (q.ratingMax) params.set("ratingMax", String(q.ratingMax));
  if (q.unrated) params.set("unrated", "1");
  if (q.animalsMin) params.set("animalsMin", String(q.animalsMin));
  if (q.animalsMax) params.set("animalsMax", String(q.animalsMax));
  if (q.onlyFeatured) params.set("onlyFeatured", "1");
  if (q.notOnInat) params.set("notOnInat", "1");
  if (q.missingDate) params.set("missingDate", "1");
  if (q.missingCoordinates) params.set("missingCoordinates", "1");
  if (q.shotActions.size > 0) params.set("action", shotTypeValues(q.shotActions, SHOT_ACTIONS).join(","));
  if (q.shotFramings.size > 0) params.set("framing", shotTypeValues(q.shotFramings, SHOT_FRAMINGS).join(","));
  for (const tier of q.tiers) params.append("tier", tier);
  if (q.tiers.length > 0 && q.tierRegionId) params.set("tierRegionId", q.tierRegionId);
  if (q.selectedTaxa.size > 0) params.set("taxa", [...q.selectedTaxa].join(","));
  for (const [key, value] of Object.entries(rawFilterParams(q.rawFiles, q.editedRaw))) params.set(key, value);
  if (q.mediaFilter === "videos") params.set("onlyVideo", "1");
  if (q.mediaFilter === "recordings") params.set("onlyAudio", "1");
  if (q.mediaFilter === "photos") params.set("excludeVideo", "1");
  if (q.dateFrom) params.set("dateFrom", q.dateFrom);
  if (q.dateTo) params.set("dateTo", q.dateTo);
  for (const id of q.regionIds) params.append("regionId", id);
  for (const tag of q.tags) params.append("tag", tag);
  for (const place of q.places) params.append("place", place);
  if (q.bbox) params.set("bbox", q.bbox);
  if (q.scopeTripId) params.set("tripId", q.scopeTripId);
  if (q.scopeAlbumId) params.set("albumId", q.scopeAlbumId);
  return params;
}

/** For the Filters badge. The RAW and media presets count when off their defaults too: the badge
 *  answers "why am I seeing fewer photos". The search doesn't count. */
export function countActiveFilters(q: GalleryQuery): number {
  return (
    (q.onlyHidden ? 1 : 0) +
    (q.ratingMin || q.ratingMax || q.unrated ? 1 : 0) +
    (q.animalsMin || q.animalsMax ? 1 : 0) +
    (q.onlyFeatured ? 1 : 0) +
    (q.notOnInat ? 1 : 0) +
    (q.missingDate ? 1 : 0) +
    (q.missingCoordinates ? 1 : 0) +
    (q.mediaFilter !== "photos" ? 1 : 0) +
    (q.rawFiles !== DEFAULT_RAW_FILES ? 1 : 0) +
    (q.editedRaw !== "any" ? 1 : 0) +
    (q.selectedTaxa.size > 0 ? 1 : 0) +
    (q.dateFrom || q.dateTo ? 1 : 0) +
    (q.regionIds.length > 0 ? 1 : 0) +
    (q.tags.length > 0 ? 1 : 0) +
    (q.places.length > 0 ? 1 : 0) +
    (q.bbox ? 1 : 0) +
    (q.shotActions.size > 0 || q.shotFramings.size > 0 ? 1 : 0) +
    (q.tiers.length > 0 ? 1 : 0) +
    (q.scopeTripId ? 1 : 0) +
    (q.scopeAlbumId ? 1 : 0)
  );
}

/** The rating filter in words ("3 to 5 stars", "Unrated"), or null when off. */
export function ratingLabel({
  ratingMin: min,
  ratingMax: max,
  unrated,
}: Pick<GalleryQuery, "ratingMin" | "ratingMax" | "unrated">): string | null {
  if (unrated) return i18n.t("gallery.toolbar.unrated");
  if (min && max)
    return min === max
      ? i18n.t("gallery.toolbar.ratingExactly", { count: min })
      : i18n.t("gallery.toolbar.ratingRange", { min, max });
  if (min)
    return min === 5
      ? i18n.t("gallery.toolbar.ratingExactly", { count: 5 })
      : i18n.t("gallery.toolbar.ratingRange", { min, max: 5 });
  if (max) return i18n.t("gallery.toolbar.ratingAtMost", { count: max });
  return null;
}

/** The number of animals filter in words ("Exactly 3 animals", "2 or more animals"), or null when off. */
export function animalsLabel({ animalsMin: min, animalsMax: max }: Pick<GalleryQuery, "animalsMin" | "animalsMax">) {
  if (!min) return null;
  return min === max
    ? i18n.t("gallery.toolbar.animalsExactly", { count: min })
    : i18n.t("gallery.toolbar.animalsAtLeast", { count: min });
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

export function toggleInList(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function toggleInSet(prev: Set<string>, value: string): Set<string> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// What a query's filter, order and time-of-day words were read as.
const READING_LABELS: Record<NonNullable<SearchInterpretation["readings"]>[number], string> = {
  lifers: "gallery.searchReading.readings.lifers",
  legendary: "gallery.searchReading.readings.legendary",
  rare: "gallery.searchReading.readings.rare",
  uncommon: "gallery.searchReading.readings.uncommon",
  occasional: "gallery.searchReading.readings.occasional",
  common: "gallery.searchReading.readings.common",
  rarestFirst: "gallery.searchReading.readings.rarestFirst",
  endemic: "gallery.searchReading.readings.endemic",
  unrated: "gallery.searchReading.readings.unrated",
  videos: "gallery.searchReading.readings.videos",
  raw: "gallery.searchReading.readings.raw",
  hidden: "gallery.searchReading.readings.hidden",
  edited: "gallery.searchReading.readings.edited",
  noLocation: "gallery.searchReading.readings.noLocation",
  noDate: "gallery.searchReading.readings.noDate",
  newestFirst: "gallery.searchReading.readings.newestFirst",
  oldestFirst: "gallery.searchReading.readings.oldestFirst",
  flying: "gallery.searchReading.readings.flying",
  behavior: "gallery.searchReading.readings.behavior",
  resting: "gallery.searchReading.readings.resting",
  close: "gallery.searchReading.readings.close",
  environmental: "gallery.searchReading.readings.environmental",
  goldenHour: "gallery.searchReading.readings.goldenHour",
  sunrise: "gallery.searchReading.readings.sunrise",
  sunset: "gallery.searchReading.readings.sunset",
  night: "gallery.searchReading.readings.night",
  morning: "gallery.searchReading.readings.morning",
  midday: "gallery.searchReading.readings.midday",
  afternoon: "gallery.searchReading.readings.afternoon",
  evening: "gallery.searchReading.readings.evening",
  blueHour: "gallery.searchReading.readings.blueHour",
  twilight: "gallery.searchReading.readings.twilight",
  ruleOfThirds: "gallery.searchReading.readings.ruleOfThirds",
  goldenRatio: "gallery.searchReading.readings.goldenRatio",
  centred: "gallery.searchReading.readings.centred",
  smallInFrame: "gallery.searchReading.readings.smallInFrame",
  frameFilling: "gallery.searchReading.readings.frameFilling",
  vertical: "gallery.searchReading.readings.vertical",
  horizontal: "gallery.searchReading.readings.horizontal",
};

/** "5 stars", "4 or more stars". */
function describeStars(s: SearchInterpretation["stars"]): string | null {
  if (!s) return null;
  if (s.max === null) return i18n.t("gallery.searchReading.starsAtLeast", { count: s.min });
  if (s.min === s.max) return i18n.t("gallery.searchReading.stars", { count: s.min });
  return i18n.t("gallery.searchReading.starsRange", { min: s.min, max: s.max });
}

/** "3 animals", "about 50 animals". */
function describeCount(c: SearchInterpretation["count"]): string | null {
  if (!c) return null;
  if (c.about !== null) return i18n.t("gallery.searchReading.animalsAbout", { count: c.about });
  if (c.crowd) return i18n.t("gallery.searchReading.crowd");
  if (c.max === null) return i18n.t("gallery.searchReading.animalsAtLeast", { count: c.min });
  if (c.min === c.max) return i18n.t("gallery.searchReading.animals", { count: c.min });
  return i18n.t("gallery.searchReading.animalsRange", { min: c.min, max: c.max });
}

/** "ducks · Washington · 2024 · looks like “swimming”". Null when there's nothing beyond the query. */
export function describeSearchReading(i: SearchInterpretation | undefined): string | null {
  if (!i) return null;
  const subject = [
    ...i.species.slice(0, 3),
    ...(i.species.length > 3 ? [i18n.t("gallery.searchReading.more", { count: i.species.length - 3 })] : []),
    ...i.groups,
  ];
  const parts = [
    formatList(subject, "unit"),
    describeCount(i.count),
    formatList(i.scenes, "unit"),
    i.backgrounds?.length
      ? i18n.t("gallery.searchReading.behind", { things: formatList(i.backgrounds, "conjunction") })
      : null,
    formatList(i.styles ?? [], "unit"),
    formatList(i.cameras ?? [], "unit"),
    describeStars(i.stars),
    ...(i.readings ?? []).map((r) => i18n.t(READING_LABELS[r])),
    i.excluded?.length ? i18n.t("gallery.searchReading.excluding", { names: formatList(i.excluded, "unit") }) : null,
    ...i.places,
    ...i.dates,
    ...i.order,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  if (i.description) parts.push(i18n.t("gallery.searchReading.looksLike", { description: i.description }));
  return parts.join(" · ");
}

/** Album and trip photos carry the same camera fields as Gallery items. */
export function itemShotData(item: {
  cameraModel?: string | null;
  lens?: string | null;
  focalLengthMm?: string | number | null;
  aperture?: string | number | null;
  shutter?: string | null;
  iso?: number | null;
}): string | null {
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

/** A filter's values on one line: "BC", "BC + Alberta", or "BC + 3 more" past two. */
export function summarizeValues(values: readonly string[]): string {
  if (values.length <= 2) return values.join(" + ");
  return i18n.t("gallery.toolbar.moreValues", { first: values[0], count: values.length - 1 });
}

/** The one real region a filter names, or null for none, several, or "no region". The local tier
 *  and "Rarity here" only mean something against a single region. */
export function soleRegionId(regionIds: readonly string[]): string | null {
  return regionIds.length === 1 && regionIds[0] !== UNCATEGORIZED_REGION_ID ? regionIds[0] : null;
}

/** The Gallery's Group choices: by region, or the Collection's species groupings. */
export type GalleryGroupBy = "none" | "region" | SpeciesGroupBy;

/** The group to show for `groupBy`: "Rarity here" needs a region filter, else it's plain Rarity. */
export function effectiveGalleryGroupBy(groupBy: GalleryGroupBy, regionFilterActive: boolean): GalleryGroupBy {
  return groupBy === "localTier" && !regionFilterActive ? "tier" : groupBy;
}

/** Each photo in exactly one group, ordered as the Collection orders them; photos keep their order
 *  within a group. Null when ungrouped. `i` is each photo's index in `items`. */
export function groupGalleryItems(
  items: GalleryItem[],
  groupBy: GalleryGroupBy,
  namingStyles?: string[],
): Array<{ key: string; label: string; entries: Array<{ item: GalleryItem; i: number }> }> | null {
  if (groupBy === "region") return groupItemsByRegion(items);
  if (groupBy !== "broad" && groupBy !== "group" && groupBy !== "tier" && groupBy !== "localTier") return null;
  const byKey = new Map<string, { item: GalleryItem; i: number }[]>();
  items.forEach((item, i) => groupInto(byKey, speciesGroupKey(item, groupBy, namingStyles), { item, i }));
  const byTier = groupBy === "tier" || groupBy === "localTier";
  return orderGroupKeys([...byKey.keys()], groupBy, (key) => byKey.get(key)!.map((e) => e.item)).map((key) => ({
    key,
    label: byTier ? tierLabel(key) : key,
    entries: byKey.get(key)!,
  }));
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
  media = "photos",
}: {
  missingDate: boolean;
  loadedCount: number;
  nextCursor: string | null;
  total: number | null;
  searchQuery: string;
  searchReading: string | null;
  media?: MediaFilter;
}): string | null {
  const totalText = (count: number) =>
    media === "both"
      ? i18n.t("gallery.count.photosAndVideos", { count })
      : media === "videos"
        ? i18n.t("gallery.count.videos", { count })
        : i18n.t("gallery.count.photos", { count });
  if (missingDate) {
    // Nothing left: the empty state says so, so no "0 photos missing a date" line above it.
    if (loadedCount === 0 && !nextCursor) return null;
    return nextCursor
      ? i18n.t("gallery.count.missingDateAtLeast", { count: loadedCount })
      : i18n.t("gallery.count.missingDate", { count: loadedCount });
  }
  if (nextCursor && total !== null) return totalText(total);
  if (nextCursor) return i18n.t("gallery.count.loadedMore", { count: loadedCount });
  if (!searchQuery) return totalText(loadedCount);
  // A reading that only repeats the query adds nothing.
  return searchReading && searchReading.trim().toLowerCase() !== searchQuery.trim().toLowerCase()
    ? i18n.t("gallery.count.matchingRead", { count: loadedCount, query: searchQuery, reading: searchReading })
    : i18n.t("gallery.count.matching", { count: loadedCount, query: searchQuery });
}

/** "photo", "video", "RAW" or "file" for the selection. `moreVideoIds` lists videos selected by a
 *  select all that aren't loaded yet; "RAW" only when every selected one is loaded and RAW-only. */
export function selectionNoun(
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  moreVideoIds: Iterable<string> = [],
): "file" | "video" | "photo" | "RAW" | "recording" {
  const selectedVideos = new Set<string>();
  let audio = 0;
  for (const it of items) {
    if (!selected.has(it.captureId)) continue;
    if (it.kind === "video") selectedVideos.add(it.captureId);
    else if (it.kind === "audio") audio += 1;
  }
  for (const id of moreVideoIds) if (selected.has(id)) selectedVideos.add(id);
  const rawOnly = items.filter((it) => selected.has(it.captureId) && it.originalKind === "raw").length;
  return mediaNoun(
    selectedVideos.size > 0,
    selected.size > selectedVideos.size + audio,
    rawOnly > 0 && rawOnly === selected.size,
    audio > 0,
  );
}

/** Whether any selected photo has a RAW beside its edited original, loaded or (from a select all)
 *  not. A RAW-only photo is its RAW, so deleting it removes the RAW anyway. */
export function selectionHasRaw(
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  moreRawIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    selected.size > 0 &&
    (items.some((it) => selected.has(it.captureId) && it.hasRawOriginal && it.originalKind !== "raw") ||
      anySelectedIn(moreRawIds, selected))
  );
}

/** The selected photos that already have coordinates; `moreLocatedIds` covers ones not loaded yet. */
export function selectionLocated(
  items: GalleryItem[],
  selected: ReadonlySet<string>,
  moreLocatedIds: ReadonlySet<string> | undefined,
): Set<string> {
  const located = new Set([...(moreLocatedIds ?? [])].filter((id) => selected.has(id)));
  for (const it of items) if (selected.has(it.captureId) && it.lat != null && it.lon != null) located.add(it.captureId);
  return located;
}

// A search that only names a kind of shot ("flight", "portraits") is the Shot type filter, so it
// lists (and sorts) like any filter. Searches that say more go to the server, which reads the same words.
const SHOT_KIND_SEARCHES: Record<string, LegacyShotKind> = {
  flight: "flight",
  flying: "flight",
  "in flight": "flight",
  "bird in flight": "flight",
  "birds in flight": "flight",
  portrait: "portrait",
  portraits: "portrait",
  behavior: "behavior",
  behaviour: "behavior",
  environmental: "environmental",
};

/** The shot type a search names on its own (with or without "shot(s)"), or null. */
export function shotTypeForSearch(query: string): ShotTypeFilter | null {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/\s+shots?$/, "")
    .replace(/\s+/g, " ");
  const kind = SHOT_KIND_SEARCHES[q];
  return kind ? shotTypeForKind(kind) : null;
}

export interface ShotTypeFilter {
  actions: ReadonlySet<string>;
  framings: ReadonlySet<string>;
}

/** The older single shot kind (saved rules, old links) as the axis it stands for. */
export function shotTypeForKind(kind: string | null | undefined): ShotTypeFilter {
  const legacy: { action?: string; framing?: string } | undefined =
    kind && kind in LEGACY_SHOT_KINDS ? LEGACY_SHOT_KINDS[kind as LegacyShotKind] : undefined;
  return {
    actions: new Set(legacy?.action ? [legacy.action] : []),
    framings: new Set(legacy?.framing ? [legacy.framing] : []),
  };
}

export type SearchPart = NonNullable<SearchInterpretation["parts"]>[number];

/** A search part as a token: what it was read as, "probably" when it's the picture model's guess. */
export function searchPartLabel(part: SearchPart): string {
  const label =
    part.kind === "background" ? i18n.t("gallery.searchPart.background", { label: part.label }) : part.label;
  return part.exact ? label : i18n.t("gallery.searchPart.probably", { label });
}

/** The query without one part's words (matched whatever the case or punctuation between them), or
 *  the query unchanged when they can't be found. */
export function removeSearchPart(query: string, part: Pick<SearchPart, "text">): string {
  const words = part.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return query;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "iu");
  if (!pattern.test(query)) return query;
  return query
    .replace(pattern, " ")
    .replace(/\s*,(\s*,)*/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}
