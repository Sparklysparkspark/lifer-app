import { filterByQuery } from "../searchNormalize";

export type PaletteAction =
  | { type: "navigate"; to: string }
  | { type: "external"; url: string }
  | { type: "setQuery"; query: string }
  // Opens the iNaturalist "any taxa" search once the palette has closed.
  | { type: "inatSearch"; query: string };

export interface PaletteItem {
  // Unique across the whole palette; also the DOM id suffix for aria-activedescendant.
  id: string;
  label: string;
  sublabel?: string;
  // Italic secondary text, for scientific names.
  italicSublabel?: boolean;
  thumbUrl?: string;
  action: PaletteAction;
}

export type PaletteGroupId =
  "recent" | "species" | "photos" | "scope" | "regions" | "trips" | "albums" | "settings" | "actions";

export interface PaletteGroup {
  id: PaletteGroupId;
  title: string;
  // Items with a thumbUrl come first and render as a thumbnail row.
  items: PaletteItem[];
}

export interface PaletteContext {
  // From a collection view (/?region=) or a species page (?regionId=).
  regionId: string | null;
  scope: { kind: "trip" | "album"; id: string } | null;
}

const UUIDISH = /^[0-9a-f-]{8,}$/i;

/** What the current page lets the palette narrow to. */
export function derivePaletteContext(pathname: string, search: string): PaletteContext {
  const params = new URLSearchParams(search);
  let regionId: string | null = null;
  if (pathname === "/") regionId = params.get("region");
  else if (pathname.startsWith("/species/")) regionId = params.get("regionId");
  if (regionId && !UUIDISH.test(regionId)) regionId = null;

  const match = /^\/(trips|albums)\/([^/]+)\/?$/.exec(pathname);
  const scope = match
    ? { kind: match[1] === "trips" ? ("trip" as const) : ("album" as const), id: decodeURIComponent(match[2]) }
    : null;
  return { regionId, scope };
}

// The Gallery's persisted presets (usePersistedState keys galleryRawFilter / galleryMediaFilter),
// so palette thumbnails never show a photo the Gallery is set to hide.
export type GalleryRawPreset = "any" | "with" | "without";
export type GalleryMediaPreset = "both" | "photos" | "videos";
export const GALLERY_RAW_PRESET_KEY = "galleryRawFilter";
export const GALLERY_MEDIA_PRESET_KEY = "galleryMediaFilter";

export function galleryPresetParams(raw: GalleryRawPreset, media: GalleryMediaPreset): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === "without") out.excludeHasRaw = "1";
  else if (raw === "with") out.onlyHasRaw = "1";
  if (media === "photos") out.excludeVideo = "1";
  else if (media === "videos") out.onlyVideo = "1";
  return out;
}

/** The Gallery searching one trip or album. The album key is inAlbum: ?albumId= is its add-photos picker. */
export function galleryScopePath(scope: { kind: "trip" | "album"; id: string }, query: string): string {
  const params = new URLSearchParams({ [scope.kind === "trip" ? "tripId" : "inAlbum"]: scope.id });
  if (query) params.set("q", query);
  return `/gallery?${params}`;
}

export function speciesPath(speciesId: string, regionId: string | null): string {
  return `/species/${speciesId}${regionId ? `?regionId=${encodeURIComponent(regionId)}` : ""}`;
}

/** Newest first, de-duplicated case-insensitively, capped. */
export function pushRecentQuery(recent: readonly string[], query: string, max = 8): string[] {
  const q = query.trim();
  if (!q) return [...recent];
  return [q, ...recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, max);
}

/** Empty groups dropped, then every item in display order, for arrow-key navigation across groups. */
export function flattenGroups(groups: readonly PaletteGroup[]): { groups: PaletteGroup[]; items: PaletteItem[] } {
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  return { groups: nonEmpty, items: nonEmpty.flatMap((g) => g.items) };
}

/** Wraps at both ends; -1 only when there is nothing to highlight. */
export function moveHighlight(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const start = index < 0 ? (delta > 0 ? -1 : 0) : index;
  return (((start + delta) % length) + length) % length;
}

/** Keeps the highlighted item across a results refresh when it is still there, else the first. */
export function resolveHighlight(items: readonly PaletteItem[], highlightedId: string | null): number {
  if (items.length === 0) return -1;
  const i = highlightedId ? items.findIndex((it) => it.id === highlightedId) : -1;
  return i >= 0 ? i : 0;
}

export interface StaticEntry {
  id: string;
  label: string;
  sublabel?: string;
  keywords?: string[];
  action: PaletteAction;
}

/** Client-side filter for lists the palette already holds (regions, trips, settings, actions). */
export function filterEntries(entries: readonly StaticEntry[], query: string, limit: number): PaletteItem[] {
  return filterByQuery(entries, query, (e) => [e.label, ...(e.keywords ?? [])], limit).map(
    ({ keywords: _k, ...item }) => item,
  );
}
