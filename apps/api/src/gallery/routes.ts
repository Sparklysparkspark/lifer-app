// Gallery of every photo across all species, plus photo search.
import { NOT_A_LINKED_VERSION } from "../captures/hidden.js";
import { galleryItemForDevice, sensitiveForKey, withoutSensitivePlace } from "../companion/privacy.js";
import { mapAreaSql } from "./mapArea.js";
import { insideSpotSql, metresTo } from "../places/spotArea.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { captureIdsOfShotTypes } from "../stats/shotKinds.js";
import { pool } from "@lifer/core/db.js";
import { Type, type Static, type TSchema } from "typebox";
import { isUuid, parseDate, parseLimit } from "../lib/validate.js";
import { Ok, Uuid, replies, withSchemas } from "../lib/schema.js";
import { GalleryItem, SearchInterpretation, SimilarGroupList } from "./responses.js";
import { taxonomicOrderKeys } from "../lib/taxonomicOrder.js";
import { TIER_RANK } from "./searchTerms.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { PLACE_NAME_MAX } from "../captures/places.js";
import { versionLabel } from "../uploads/versionGrouping.js";
import { EMBEDDING_MODEL_VERSION, SCENE_MODEL_VERSION } from "@lifer/core/config.js";
import { dismissSimilarGroup, setDismissed, similarGroupOf, similarGroups } from "./similar.js";
import {
  parseSearchQuery,
  rankSearch,
  type ParsedQuery,
  type PlaceEntry,
  type Reading,
  type SearchOutcome,
  type SearchRow,
  type SpeciesEntry,
} from "./photoSearch.js";
import type { GroupPredicate } from "./searchTaxonSynonyms.js";
import {
  LEGACY_SHOT_KINDS,
  SHOT_ACTIONS,
  SHOT_FRAMINGS,
  parseShotList,
  compositionOf,
  orientationOf,
  timeMaybeWrong,
  trustedSun,
  type CullLabel,
  type FrameBox,
  type LightStats,
  type LegacyShotKind,
  type ShotAction,
  type ShotFraming,
} from "@lifer/shared";

// Thumbnails per group in the similar photos list.
const SIMILAR_PREVIEWS = 4;

/** Sentinel `regionId` for the "Uncategorized" filter: captures with no region set. */
export const UNCATEGORIZED_REGION_ID = "uncategorized";

/** A region filter matches that region and every descendant. The root region (World) also
 *  matches captures with no region, so it never hides untagged photos. */
function regionMatchClause(paramIdx: number): string {
  return `(
             c.region_id IN (
               WITH RECURSIVE region_tree AS (
                 SELECT id FROM regions WHERE id = ANY($${paramIdx}::uuid[])
                 UNION ALL
                 -- home_country_id: a province shown under its continent still belongs to its country.
                 SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id OR r.home_country_id = rt.id
               )
               SELECT id FROM region_tree
             )
             OR (c.region_id IS NULL AND EXISTS (SELECT 1 FROM regions WHERE id = ANY($${paramIdx}::uuid[]) AND parent_id IS NULL))
           )`;
}

// A photo's species tier, the user's own winning as on the Collection.
export const GALLERY_TIER_SQL = `COALESCE(
    (SELECT gto.tier FROM user_tier_overrides gto
      WHERE gto.user_id = c.user_id AND gto.species_id = c.species_id AND gto.region_id IS NULL LIMIT 1),
    (SELECT gsr.tier FROM species_rarity gsr WHERE gsr.species_id = c.species_id)
  )`;

// Columns shared by /gallery and /gallery/search, so filters stay in sync between them.
export const GALLERY_ITEM_COLUMNS = `
  c.id AS capture_id, p.id AS photo_id, p.width, p.height, c.species_id, s.scientific_name, s.common_name, s.taxon_class,
  c.taken_at, c.created_at, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
  c.lat, c.lon, c.region_id, reg.name AS region_name, c.location_label, p.kind AS photo_kind, p.duration_seconds, c.tags,
  c.cull_verdict, c.cull_label, c.hidden_at IS NOT NULL AS hidden,
  (p.id = us.cover_photo_id) AS is_featured,
  EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original,
  (SELECT io.status FROM capture_inaturalist_observations io WHERE io.capture_id = c.id AND io.photo_sent) AS inat_status,
  (SELECT io.inat_observation_id FROM capture_inaturalist_observations io WHERE io.capture_id = c.id AND io.photo_sent) AS inat_observation_id,
  o.ref AS original_ref, o.managed AS original_managed, o.kind AS original_kind,
  (SELECT rr.ref FROM originals rr WHERE rr.capture_id = c.id AND rr.kind = 'raw' LIMIT 1) AS raw_ref,
  s.taxon_order, s.family, s.sort_order, s.is_other_taxa, s.inat_iconic_taxon,
  ${GALLERY_TIER_SQL} AS tier,
  cfr.box AS frame_box, cfr.box_unsure AS frame_unsure, cfr.aspect AS frame_aspect, cfr.light AS light_stats,
  c.taken_at_zoned
`;

/** With a region filter: the extra column of each photo's tier there (the user's own first, as on
 *  a region's checklist), for grouping by "Rarity here". Empty otherwise. */
export function galleryLocalTierColumn(f: Pick<GalleryFilters, "regionIds">, param: (v: unknown) => string): string {
  // With several regions there is no single "here" to rank against.
  if (f.regionIds.length !== 1 || f.regionIds[0] === UNCATEGORIZED_REGION_ID) return "";
  const r = param(f.regionIds[0]);
  return `, COALESCE(
    (SELECT lto.tier FROM user_tier_overrides lto
      WHERE lto.user_id = c.user_id AND lto.species_id = c.species_id AND (lto.region_id = ${r}::uuid OR lto.region_id IS NULL)
      ORDER BY lto.region_id NULLS LAST LIMIT 1),
    (SELECT lrs.local_tier FROM region_species lrs WHERE lrs.species_id = c.species_id AND lrs.region_id = ${r}::uuid)
  ) AS local_tier`;
}
export const GALLERY_ITEM_JOINS = `
  JOIN photos p ON p.id = c.current_photo_id
  JOIN species s ON s.id = c.species_id
  LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
  LEFT JOIN regions reg ON reg.id = c.region_id
  -- jpeg-preferred tiebreak (same as SpeciesDetailPage's own capture query), original_kind
  -- from THIS row is what "include RAW-derived photos" filters against: a capture whose only
  -- original is a RAW file has no jpeg to win the tiebreak, so this resolves to 'raw'.
  LEFT JOIN LATERAL (
    SELECT * FROM originals lo WHERE lo.capture_id = c.id ORDER BY (lo.kind = 'jpeg') DESC LIMIT 1
  ) o ON true
`;
/** GALLERY_ITEM_JOINS plus the photo's frame, for queries that select GALLERY_ITEM_COLUMNS. Kept
 *  out of the filter-only queries (counts, the map), where the planner wouldn't drop it. */
export const GALLERY_ITEM_FRAME_JOINS = `${GALLERY_ITEM_JOINS}
  LEFT JOIN capture_frames cfr ON cfr.capture_id = c.id AND cfr.photo_id = p.id
`;

// The filters /gallery and /gallery/search share, parsed and validated once. Ids and dates that
// wouldn't survive a Postgres cast get a 400 instead of a 500.
export interface GalleryFilters {
  onlyHidden: boolean;
  /** Star rating range, both ends inclusive; either end may be open. Unrated photos never match a range. */
  ratingMin: number | null;
  ratingMax: number | null;
  /** Only photos with no star rating. */
  unrated: boolean;
  /** Only photos not yet sent to iNaturalist. */
  notOnInat: boolean;
  /** How many animals the detector found, both ends inclusive; uncounted photos never match. */
  animalsMin: number | null;
  animalsMax: number | null;
  onlyFeatured: boolean;
  taxa: string[];
  includeRaw: boolean;
  onlyRaw: boolean;
  excludeHasRaw: boolean;
  onlyHasRaw: boolean;
  onlyVideo: boolean;
  onlyAudio: boolean;
  excludeVideo: boolean;
  missingDate: boolean;
  missingCoordinates: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  // Each of these is a list: a photo matches when it has any one of the values, and every filter
  // that is set must match (OR within a filter, AND across filters).
  regionIds: string[];
  tags: string[];
  /** Only photos with exactly one of these place names (location_label). */
  places: string[];
  /** Only photos whose coordinates fall in this box (west, south, east, north); west > east crosses
   *  the antimeridian. */
  bbox?: [number, number, number, number] | null;
  /** Also photos with no coordinates set to exactly one of these regions, alongside the bbox's
   *  (a map cluster's dots and rings in one list). */
  orRegionOnly?: string[];
  /** Only photos whose point lies inside this saved place's radius. */
  spotId?: string | null;
  tripIds: string[];
  albumIds: string[];
  /** Shot type: any of these actions, and any of these framings (an empty list is any). */
  shotActions: ShotAction[];
  shotFramings: ShotFraming[];
  /** Only species of one of these rarity tiers (species_rarity), from Stats' By tier list. */
  tiers: string[];
  /** With `tier`: compare each species' local tier in this region instead of its overall one. */
  tierRegionId: string | null;
  /** The captures of the shot type, filled in by galleryFiltersFor (it's worked out from vectors). */
  shotTypeCaptureIds?: string[];
  /** The members of the smart albums in `albumIds`, filled in by galleryFiltersFor (their rules pick
   *  them, not album_captures). Those albums are removed from `albumIds`, which keeps the plain ones. */
  albumCaptureIds?: string[];
  /** Only this photo and its near-identical ones (similar.ts). */
  similarTo: string | null;
  /** The group `similarTo` stands for, filled in by galleryFiltersFor. */
  similarCaptureIds?: string[];
}

const STAR_VALUES = ["1", "2", "3", "4", "5"];

// "1" turns a filter on; "0" (or leaving it out) leaves it off.
const OnOff = (description: string) => Type.Optional(Type.Enum(["0", "1"], { description }));

/** The captures a filter set lists from: the `captures` view, or with `hidden=1` the hidden
 *  photos it leaves out (hidden.ts). */
export function galleryCapturesSource(f: Pick<GalleryFilters, "onlyHidden">): string {
  return f.onlyHidden
    ? `(SELECT * FROM captures_all c WHERE deleted_at IS NULL AND hidden_at IS NOT NULL AND ${NOT_A_LINKED_VERSION})`
    : "captures";
}

// Room for every region of a large library picked at once.
const MAX_FILTER_VALUES = 500;

// A filter that takes several values: repeat the param (?regionId=a&regionId=b). A photo matches
// any one of them; one value alone still works.
const Many = <T extends TSchema>(item: T, description: string) =>
  Type.Optional(Type.Array(item, { description, maxItems: MAX_FILTER_VALUES }));

// The filters /gallery, /gallery/ids and /gallery/search share (and smart album rules).
export const GalleryFilterQuery = Type.Object({
  taxa: Type.Optional(Type.String({ description: "Comma-separated taxon classes" })),
  regionId: Many(
    Type.Union([Uuid(), Type.Literal(UNCATEGORIZED_REGION_ID)]),
    'Region, or "uncategorized" for photos with no region',
  ),
  // A prefix check only: parseDay below also refuses dates that don't exist.
  dateFrom: Type.Optional(
    Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}", description: "Taken on or after (YYYY-MM-DD)" }),
  ),
  dateTo: Type.Optional(
    Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}", description: "Taken on or before (YYYY-MM-DD)" }),
  ),
  tag: Many(Type.String(), "Only photos with this tag"),
  place: Many(Type.String({ maxLength: PLACE_NAME_MAX }), "Only photos with this place name"),
  bbox: Type.Optional(
    Type.String({
      pattern: "^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$",
      description: "Only photos with coordinates in this box: west,south,east,north in degrees",
    }),
  ),
  spotId: Type.Optional(Uuid({ description: "Only photos whose coordinates fall inside this saved place" })),
  orRegionOnly: Many(
    Uuid(),
    "With bbox: also photos with no coordinates set to exactly this region (a map ring), in the same list",
  ),
  tripId: Many(Uuid(), "Only photos in this trip"),
  albumId: Many(Uuid(), "Only photos in this album"),
  similarTo: Type.Optional(
    Uuid({
      description:
        "Only this photo and its near-identical ones (bursts and repeats), whatever the RAW and video presets",
    }),
  ),
  missingDate: OnOff("1 for photos with no capture date only"),
  missingCoordinates: OnOff("1 for photos with no coordinates only"),
  tier: Many(
    Type.Enum(["legendary", "rare", "uncommon", "occasional", "common", "unrated"]),
    "Only species of this rarity tier",
  ),
  tierRegionId: Type.Optional(Uuid({ description: "With tier: the region whose local tier counts" })),
  action: Type.Optional(
    Type.String({
      pattern: `^(${SHOT_ACTIONS.join("|")})(,(${SHOT_ACTIONS.join("|")}))*$`,
      description: `Only photos with one of these comma-separated actions (${SHOT_ACTIONS.join(", ")}), as Stats' Photography DNA reads them`,
    }),
  ),
  framing: Type.Optional(
    Type.String({
      pattern: `^(${SHOT_FRAMINGS.join("|")})(,(${SHOT_FRAMINGS.join("|")}))*$`,
      description: `Only photos with one of these comma-separated framings (${SHOT_FRAMINGS.join(", ")})`,
    }),
  ),
  // Saved smart albums and old links still carry it.
  shotKind: Type.Optional(
    Type.Enum(Object.keys(LEGACY_SHOT_KINDS) as LegacyShotKind[], {
      description: "Older single shot type: flight and behavior are an action, portrait and environmental a framing",
      deprecated: true,
    }),
  ),
  onlyTopRated: OnOff("1 for 5-star photos only (the same as ratingMin=5)"),
  ratingMin: Type.Optional(Type.Enum(STAR_VALUES, { description: "Only photos rated at least this many stars" })),
  ratingMax: Type.Optional(Type.Enum(STAR_VALUES, { description: "Only photos rated at most this many stars" })),
  unrated: OnOff("1 for photos with no star rating only (not with ratingMin or ratingMax)"),
  notOnInat: OnOff("1 for photos not yet sent to iNaturalist"),
  animalsMin: Type.Optional(
    Type.String({ pattern: "^[1-9][0-9]{0,3}$", description: "Only photos with at least this many animals" }),
  ),
  animalsMax: Type.Optional(
    Type.String({ pattern: "^[1-9][0-9]{0,3}$", description: "Only photos with at most this many animals" }),
  ),
  onlyFeatured: OnOff("1 for species cover photos only"),
  onlyVideo: OnOff("1 for videos only"),
  onlyAudio: OnOff("1 for sound recordings only"),
  excludeVideo: OnOff("1 to leave videos out"),
  onlyHasRaw: OnOff("1 for photos with a RAW original only (RAW-only photos included)"),
  excludeHasRaw: OnOff("1 to leave out edited photos that have a RAW original (RAW-only photos stay)"),
  includeRaw: OnOff("0 to leave out photos whose only original is a RAW"),
  onlyRaw: OnOff("1 for only the photos whose only original is a RAW"),
  hidden: OnOff("1 for only the photos imported hidden because a culling app rejected them"),
});
export type GalleryFilterQuery = Static<typeof GalleryFilterQuery>;

// Plain YYYY-MM-DD from a native <input type="date">; anything else Postgres can't cast is refused.
function parseDay(value: string | undefined): string | null | undefined {
  if (!value) return null;
  const day = value.slice(0, 10);
  // JS rolls 2024-02-31 over to March, so the day must survive the round trip.
  const d = parseDate(day);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(day) || d.toISOString().slice(0, 10) !== day) return undefined;
  return day;
}

// Blank and repeated values dropped, order kept.
const distinct = (values: readonly string[] | undefined): string[] => [...new Set(values?.filter(Boolean))];

export function parseGalleryFilters(q: GalleryFilterQuery): GalleryFilters | { error: string } {
  const dateFrom = parseDay(q.dateFrom);
  const dateTo = parseDay(q.dateTo);
  if (dateFrom === undefined || dateTo === undefined) return { error: "dateFrom and dateTo must be YYYY-MM-DD dates" };
  // The query schema already refused malformed region, trip and album ids.
  // The older "top rated" switch is the 5-star end of the range.
  const ratingMin = q.onlyTopRated === "1" ? 5 : q.ratingMin ? Number(q.ratingMin) : null;
  const ratingMax = q.ratingMax ? Number(q.ratingMax) : null;
  const unrated = q.unrated === "1";
  if (ratingMin !== null && ratingMax !== null && ratingMin > ratingMax)
    return { error: "ratingMin can't be more than ratingMax" };
  if (unrated && (ratingMin !== null || ratingMax !== null))
    return { error: "unrated can't be combined with a star rating range" };
  const animalsMin = q.animalsMin ? Number(q.animalsMin) : null;
  const animalsMax = q.animalsMax ? Number(q.animalsMax) : null;
  if (animalsMin !== null && animalsMax !== null && animalsMin > animalsMax)
    return { error: "animalsMin can't be more than animalsMax" };
  const shotActions = parseShotList(q.action, SHOT_ACTIONS);
  const shotFramings = parseShotList(q.framing, SHOT_FRAMINGS);
  const legacy: { action?: ShotAction; framing?: ShotFraming } | undefined =
    q.shotKind && LEGACY_SHOT_KINDS[q.shotKind as LegacyShotKind];
  const bbox = q.bbox ? q.bbox.split(",").map(Number) : null;
  if (
    bbox &&
    (bbox.some((v) => !Number.isFinite(v)) ||
      bbox[1] > bbox[3] ||
      [bbox[1], bbox[3]].some((v) => Math.abs(v) > 90) ||
      [bbox[0], bbox[2]].some((v) => Math.abs(v) > 180))
  )
    return { error: "bbox must be west,south,east,north in degrees, with south at or below north" };
  if (legacy?.action && !shotActions.includes(legacy.action)) shotActions.push(legacy.action);
  if (legacy?.framing && !shotFramings.includes(legacy.framing)) shotFramings.push(legacy.framing);
  return {
    onlyHidden: q.hidden === "1",
    ratingMin,
    ratingMax,
    unrated,
    notOnInat: q.notOnInat === "1",
    animalsMin,
    animalsMax,
    onlyFeatured: q.onlyFeatured === "1",
    taxa: q.taxa?.split(",").filter(Boolean) ?? [],
    includeRaw: q.includeRaw !== "0",
    onlyRaw: q.onlyRaw === "1",
    excludeHasRaw: q.excludeHasRaw === "1",
    onlyHasRaw: q.onlyHasRaw === "1",
    onlyVideo: q.onlyVideo === "1",
    onlyAudio: q.onlyAudio === "1",
    excludeVideo: q.excludeVideo === "1",
    // Captures with no taken_at (Stats page drill-down).
    missingDate: q.missingDate === "1",
    missingCoordinates: q.missingCoordinates === "1",
    // dateTo includes the whole day (< the next day).
    dateFrom,
    dateTo,
    regionIds: distinct(q.regionId),
    tags: distinct(q.tag),
    places: distinct(q.place?.map((p) => p.trim())),
    bbox: bbox as [number, number, number, number] | null,
    orRegionOnly: distinct(q.orRegionOnly),
    spotId: q.spotId || null,
    tripIds: distinct(q.tripId),
    albumIds: distinct(q.albumId),
    shotActions,
    shotFramings,
    tiers: distinct(q.tier),
    tierRegionId: q.tierRegionId || null,
    similarTo: q.similarTo || null,
  };
}

/** parseGalleryFilters, plus the captures a shot type or a smart ?albumId= stands for. `seenAlbums`
 *  is the smart albums already being resolved, so rules that scope to themselves can't loop. */
export async function galleryFiltersFor(
  q: GalleryFilterQuery,
  userId: string,
  seenAlbums: ReadonlySet<string> = new Set(),
): Promise<GalleryFilters | { error: string }> {
  const filters: GalleryFilters | { error: string } = parseGalleryFilters(q);
  if ("error" in filters) return filters;
  await withShotTypeIds(filters, userId);
  if (filters.similarTo) {
    filters.similarCaptureIds = await similarGroupOf(userId, filters.similarTo);
    // The group is shown whole: a burst is often RAW-only frames the browsing presets leave out.
    Object.assign(filters, {
      includeRaw: true,
      onlyRaw: false,
      excludeHasRaw: false,
      onlyHasRaw: false,
      onlyVideo: false,
      onlyAudio: false,
      excludeVideo: false,
    });
  }
  if (filters.albumIds.length > 0) {
    // Imported lazily: albums/routes builds on this module.
    const { smartAlbumCaptureIds } = await import("../albums/routes.js");
    const plain: string[] = [];
    let smart: string[] | undefined;
    for (const id of filters.albumIds) {
      const ids = await smartAlbumCaptureIds(id, userId, seenAlbums);
      if (ids) smart = [...(smart ?? []), ...ids];
      else plain.push(id);
    }
    filters.albumCaptureIds = smart;
    filters.albumIds = plain;
  }
  return filters;
}

/** Fills in the captures a filter set's shot type stands for. */
async function withShotTypeIds(f: GalleryFilters, userId: string): Promise<GalleryFilters> {
  if (f.shotActions.length > 0 || f.shotFramings.length > 0)
    f.shotTypeCaptureIds = await captureIdsOfShotTypes(userId, f.shotActions, f.shotFramings);
  return f;
}

/** At a place: the label, or a point inside the user's saved place of that name (as its photo count). */
function placeClause(names: string): string {
  return `AND (c.location_label = ANY(${names}::text[]) OR (c.lat IS NOT NULL AND c.lon IS NOT NULL AND EXISTS (
    SELECT 1 FROM saved_spots s
    WHERE s.user_id = c.user_id AND lower(s.name) = ANY(SELECT lower(n) FROM unnest(${names}::text[]) n)
      AND c.lat BETWEEN s.lat - s.radius_m / 111320.0 AND s.lat + s.radius_m / 111320.0
      AND ${metresTo("s")} <= s.radius_m)))`;
}

/** The WHERE clauses for a filter set, adding each value through `param` ($n placeholders). */
export function galleryFilterSql(f: GalleryFilters, param: (v: unknown) => string): string {
  const uncategorized = f.regionIds.includes(UNCATEGORIZED_REGION_ID);
  const regionIds = f.regionIds.filter((id) => id !== UNCATEGORIZED_REGION_ID);
  return [
    f.ratingMin !== null ? `AND c.quality_rating >= ${param(f.ratingMin)}::int` : "",
    f.ratingMax !== null ? `AND c.quality_rating <= ${param(f.ratingMax)}::int` : "",
    f.unrated ? "AND c.quality_rating IS NULL" : "",
    f.notOnInat
      ? // Photos ignored for iNaturalist aren't waiting to go there either.
        "AND c.inat_ignored_at IS NULL AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations io WHERE io.capture_id = c.id AND io.photo_sent)"
      : "",
    f.animalsMin !== null ? `AND c.subject_count >= ${param(f.animalsMin)}::int` : "",
    f.animalsMax !== null ? `AND c.subject_count <= ${param(f.animalsMax)}::int` : "",
    // "Featured" means this photo is its species' cover_photo_id, not a photo-level flag.
    f.onlyFeatured ? "AND p.id = us.cover_photo_id" : "",
    f.missingDate ? "AND c.taken_at IS NULL" : "",
    f.missingCoordinates ? "AND (c.lat IS NULL OR c.lon IS NULL)" : "",
    f.tiers.length > 0 && f.tierRegionId
      ? `AND COALESCE((SELECT rs.local_tier FROM region_species rs WHERE rs.species_id = c.species_id AND rs.region_id = ${param(f.tierRegionId)}::uuid), 'unrated') = ANY(${param(f.tiers)}::text[])`
      : f.tiers.length > 0
        ? `AND EXISTS (SELECT 1 FROM species_rarity sr WHERE sr.species_id = c.species_id AND sr.tier = ANY(${param(f.tiers)}::text[]))`
        : "",
    f.shotActions.length > 0 || f.shotFramings.length > 0
      ? `AND c.id = ANY(${param(f.shotTypeCaptureIds ?? [])}::uuid[])`
      : "",
    f.taxa.length > 0 ? `AND s.taxon_class = ANY(${param(f.taxa)})` : "",
    f.dateFrom ? `AND c.taken_at >= ${param(f.dateFrom)}::date` : "",
    f.dateTo ? `AND c.taken_at < (${param(f.dateTo)}::date + INTERVAL '1 day')` : "",
    uncategorized || regionIds.length > 0
      ? `AND (${[
          uncategorized ? "c.region_id IS NULL" : "",
          regionIds.length > 0 ? regionMatchClause(Number(param(regionIds).slice(1))) : "",
        ]
          .filter(Boolean)
          .join(" OR ")})`
      : "",
    f.tags.length > 0 ? `AND c.tags && ${param(f.tags)}::text[]` : "",
    f.places.length > 0 ? placeClause(param(f.places)) : "",
    mapAreaSql(f, param),
    insideSpotSql(f.spotId, param),
    f.tripIds.length > 0 ? `AND c.trip_id = ANY(${param(f.tripIds)}::uuid[])` : "",
    f.similarTo ? `AND c.id = ANY(${param(f.similarCaptureIds ?? [])}::uuid[])` : "",
    // EXISTS rather than a JOIN so a photo in an album is never listed twice.
    f.albumCaptureIds || f.albumIds.length > 0
      ? `AND (${[
          f.albumCaptureIds ? `c.id = ANY(${param(f.albumCaptureIds)}::uuid[])` : "",
          f.albumIds.length > 0
            ? `EXISTS (SELECT 1 FROM album_captures fac WHERE fac.capture_id = c.id AND fac.album_id = ANY(${param(f.albumIds)}::uuid[]))`
            : "",
        ]
          .filter(Boolean)
          .join(" OR ")})`
      : "",
    // `o` is the photo's main original, the edited one when there is one: a RAW there means the
    // RAW is all the photo has.
    f.includeRaw ? "" : "AND o.kind IS DISTINCT FROM 'raw'",
    f.onlyRaw ? "AND o.kind = 'raw'" : "",
    // The "with RAW" pair of filters is about edited photos, so a RAW-only photo passes both.
    f.excludeHasRaw
      ? "AND (o.kind = 'raw' OR NOT EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw'))"
      : f.onlyHasRaw
        ? "AND EXISTS (SELECT 1 FROM originals hr WHERE hr.capture_id = c.id AND hr.kind = 'raw')"
        : "",
    f.onlyVideo ? "AND p.kind = 'video'" : "",
    f.onlyAudio ? "AND p.kind = 'audio'" : "",
    // The Photos choice: recordings are their own media type.
    f.excludeVideo ? "AND p.kind NOT IN ('video', 'audio')" : "",
  ]
    .filter(Boolean)
    .join("\n           ");
}

// /gallery sort orders. Unrated sorts as a middle 3 so it doesn't sink to either end. c.id breaks
// ties so keyset pages never skip or repeat a photo.
interface SortKey {
  expr: string;
  desc: boolean;
  nullable: boolean;
  cast: string;
}
// Within one species, newest first.
const NEWEST_KEYS: SortKey[] = [
  { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
  { expr: "c.created_at", desc: true, nullable: false, cast: "timestamptz" },
];
const FIELD_GUIDE_KEYS: SortKey[] = taxonomicOrderKeys().map((k) => ({ ...k, desc: false }));
// Search's rarest-first rank (legendary highest); unrated and unknown last.
const TIER_RANK_SQL = `COALESCE(CASE ${GALLERY_TIER_SQL} ${Object.entries(TIER_RANK)
  .map(([tier, rank]) => `WHEN '${tier}' THEN ${rank}`)
  .join(" ")} END, 0)`;
const GALLERY_SORTS: Record<string, SortKey[]> = {
  // The Collection's species orders, each photo grouped with its species.
  taxonomic: [...FIELD_GUIDE_KEYS, ...NEWEST_KEYS],
  name: [
    { expr: "COALESCE(s.common_name, s.scientific_name)", desc: false, nullable: false, cast: "text" },
    { expr: "s.scientific_name", desc: false, nullable: false, cast: "text" },
    ...NEWEST_KEYS,
  ],
  scientific: [{ expr: "s.scientific_name", desc: false, nullable: false, cast: "text" }, ...NEWEST_KEYS],
  // Field guide order within a tier, as the Collection's stable sort leaves it.
  rarity: [{ expr: TIER_RANK_SQL, desc: true, nullable: false, cast: "int" }, ...FIELD_GUIDE_KEYS, ...NEWEST_KEYS],
  newest: [
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
    { expr: "c.created_at", desc: true, nullable: false, cast: "timestamptz" },
  ],
  oldest: [
    { expr: "c.taken_at", desc: false, nullable: true, cast: "timestamptz" },
    { expr: "c.created_at", desc: false, nullable: false, cast: "timestamptz" },
  ],
  ratingHigh: [
    { expr: "COALESCE(c.quality_rating, 3)", desc: true, nullable: false, cast: "int" },
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
  ],
  ratingLow: [
    { expr: "COALESCE(c.quality_rating, 3)", desc: false, nullable: false, cast: "int" },
    { expr: "c.taken_at", desc: true, nullable: true, cast: "timestamptz" },
  ],
};

export function galleryOrderBy(keys: SortKey[]): string {
  return [
    ...keys.map((k) => `${k.expr} ${k.desc ? "DESC" : "ASC"}${k.nullable ? " NULLS LAST" : ""}`),
    "c.id ASC",
  ].join(", ");
}

interface GalleryCursor {
  sort: string;
  values: Array<string | null>;
  id: string;
}

// base64url JSON of the last row's sort values (as Postgres text, so microseconds survive) and id.
export function encodeGalleryCursor(c: GalleryCursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.values, c.id]), "utf8").toString("base64url");
}

export function decodeGalleryCursor(raw: string): GalleryCursor | null {
  try {
    const [sort, values, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof sort !== "string" || !GALLERY_SORTS[sort] || !Array.isArray(values) || !isUuid(id)) return null;
    if (values.length !== GALLERY_SORTS[sort].length || values.some((v) => v !== null && typeof v !== "string"))
      return null;
    return { sort, values, id };
  } catch {
    return null;
  }
}

/** "Comes after the cursor row" in the given order, NULLS LAST included. */
export function galleryAfterCursorSql(keys: SortKey[], cursor: GalleryCursor, param: (v: unknown) => string): string {
  const equal: string[] = [];
  const branches: string[] = [];
  keys.forEach((k, i) => {
    const v = cursor.values[i];
    if (v === null) {
      // Past the last non-null value only more nulls follow, so the key can't be "after" here.
      equal.push(`${k.expr} IS NULL`);
      return;
    }
    const p = `${param(v)}::${k.cast}`;
    const after = `${k.expr} ${k.desc ? "<" : ">"} ${p}${k.nullable ? ` OR ${k.expr} IS NULL` : ""}`;
    branches.push(`(${[...equal, `(${after})`].join(" AND ")})`);
    equal.push(`${k.expr} = ${p}`);
  });
  branches.push(`(${[...equal, `c.id > ${param(cursor.id)}::uuid`].join(" AND ")})`);
  return `AND (${branches.join(" OR ")})`;
}

// Search rows cached per user and filter set while a cheap library stamp is unchanged, and for a
// minute at most to catch changes that don't touch a photo row.
const SEARCH_ROWS_TTL_MS = 60_000;
// A search row is a gallery row plus what ranking reads.
type GallerySearchRow = SearchRow & GalleryRow;
const searchRowsCache = new Map<string, { stamp: string; at: number; rows: GallerySearchRow[] }>();
// These rows hold every photo's vector, so they're dropped once stale.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of searchRowsCache) if (now - hit.at >= SEARCH_ROWS_TTL_MS) searchRowsCache.delete(key);
  for (const [key, hit] of vocabCache) if (now - hit.at >= SEARCH_ROWS_TTL_MS) vocabCache.delete(key);
}, 60_000).unref();

// The stamp scans the user's captures, so it's reused for a few seconds per user.
const STAMP_TTL_MS = 3_000;
const stampCache = new Map<string, { stamp: string; at: number }>();

/** Test hook: forget every cached stamp, row set and vocabulary. */
export function clearGallerySearchCaches(): void {
  stampCache.clear();
  searchRowsCache.clear();
  vocabCache.clear();
}

async function libraryStamp(userId: string): Promise<string> {
  const hit = stampCache.get(userId);
  if (hit && Date.now() - hit.at < STAMP_TTL_MS) return hit.stamp;
  const res = await pool.query<{ stamp: string }>(
    `SELECT concat_ws('|', count(*), max(c.updated_at), count(c.subject_count),
              (SELECT max(ce.computed_at) FROM capture_embeddings ce JOIN captures_all c2 ON c2.id = ce.capture_id WHERE c2.user_id = $1),
              (SELECT max(cs.computed_at) FROM capture_scenes cs JOIN captures_all c2 ON c2.id = cs.capture_id WHERE c2.user_id = $1),
              (SELECT max(cf.computed_at) FROM capture_frames cf JOIN captures_all c2 ON c2.id = cf.capture_id WHERE c2.user_id = $1),
              (SELECT max(cb.computed_at) FROM capture_background_embeddings cb JOIN captures_all c2 ON c2.id = cb.capture_id WHERE c2.user_id = $1),
              (SELECT concat_ws(',', count(*), max(ac.added_at)) FROM album_captures ac JOIN albums a ON a.id = ac.album_id WHERE a.user_id = $1),
              (SELECT concat_ws(',', count(*), max(a.updated_at)) FROM albums a WHERE a.user_id = $1),
              (SELECT count(*) FROM trips t WHERE t.user_id = $1)) AS stamp
       FROM captures_all c WHERE c.user_id = $1`,
    [userId],
  );
  const stamp = res.rows[0]?.stamp ?? "";
  if (stampCache.size > 100) stampCache.delete(stampCache.keys().next().value!);
  stampCache.set(userId, { stamp, at: Date.now() });
  return stamp;
}

async function searchRows(
  userId: string,
  stamp: string,
  sql: string,
  params: unknown[],
): Promise<{ rows: GallerySearchRow[] }> {
  const key = `${userId}|${sql}|${JSON.stringify(params)}`;
  const hit = searchRowsCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SEARCH_ROWS_TTL_MS) return { rows: hit.rows };
  const res = await pool.query<GallerySearchRow>(sql, params);
  for (const [k, v] of searchRowsCache) if (k.startsWith(`${userId}|`) && v.stamp !== stamp) searchRowsCache.delete(k);
  if (searchRowsCache.size > 50) searchRowsCache.delete(searchRowsCache.keys().next().value!);
  searchRowsCache.set(key, { stamp, at: Date.now(), rows: res.rows });
  return { rows: res.rows };
}

// Places, trips and albums a query can name, and old scientific names for the user's species,
// kept per user while the library stamp holds (and a minute at most, for renames).
const vocabCache = new Map<
  string,
  { stamp: string; at: number; places: PlaceEntry[]; synonyms: Map<string, string[]> }
>();

async function searchVocabulary(
  userId: string,
  stamp: string,
): Promise<{ places: PlaceEntry[]; synonyms: Map<string, string[]> }> {
  const hit = vocabCache.get(userId);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SEARCH_ROWS_TTL_MS) return hit;
  const [places, synonymRes] = await Promise.all([
    searchablePlaces(userId),
    pool.query<{ species_id: string; names: string[] }>(
      `SELECT ss.species_id, array_agg(ss.synonym_name) AS names
         FROM species_synonyms ss
        WHERE ss.species_id IN (SELECT DISTINCT species_id FROM captures WHERE user_id = $1)
        GROUP BY ss.species_id`,
      [userId],
    ),
  ]);
  const synonyms = new Map(synonymRes.rows.map((r) => [r.species_id, r.names]));
  if (vocabCache.size > 100) vocabCache.delete(vocabCache.keys().next().value!);
  const entry = { stamp, at: Date.now(), places, synonyms };
  vocabCache.set(userId, entry);
  return entry;
}

// Places a query can name: regions with photos and their ancestors, import location labels, and
// trip and album names. "World" is left out: it contains everything.
async function searchablePlaces(userId: string): Promise<PlaceEntry[]> {
  const res = await pool.query<{ kind: PlaceEntry["kind"]; id: string; name: string }>(
    `WITH RECURSIVE up AS (
       SELECT r.id, r.name, r.parent_id FROM regions r
        WHERE r.id IN (SELECT DISTINCT region_id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL)
       UNION
       SELECT p.id, p.name, p.parent_id FROM regions p JOIN up ON up.parent_id = p.id
     )
     SELECT 'region' AS kind, id::text AS id, name FROM up WHERE parent_id IS NOT NULL
     UNION ALL
     SELECT DISTINCT 'location', location_label, location_label FROM captures
      WHERE user_id = $1 AND location_label IS NOT NULL AND location_label <> ''
     UNION ALL
     SELECT 'trip', id::text, name FROM trips WHERE user_id = $1 AND name IS NOT NULL AND name <> ''
     UNION ALL
     SELECT 'album', id::text, name FROM albums WHERE user_id = $1 AND name IS NOT NULL AND name <> ''`,
    [userId],
  );
  return res.rows;
}

// True once the client has gone away (a newer keystroke cancelled this search).
function watchClientGone(request: FastifyRequest, reply: FastifyReply): () => boolean {
  let gone = false;
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) gone = true;
  });
  return () => gone || request.raw.socket?.destroyed === true;
}

// Latin order and family names from the whole catalog, so they filter exactly rather than via CLIP.
// Cached: the catalog changes only on an update.
let latinGroupCache: { at: number; map: Map<string, GroupPredicate> } | null = null;
async function latinGroupNames(): Promise<Map<string, GroupPredicate>> {
  if (latinGroupCache && Date.now() - latinGroupCache.at < 10 * 60_000) return latinGroupCache.map;
  const res = await pool.query<{ kind: "order" | "family"; name: string }>(
    `SELECT DISTINCT 'order' AS kind, lower(taxon_order) AS name FROM species WHERE taxon_order IS NOT NULL
     UNION
     SELECT DISTINCT 'family', lower(family) FROM species WHERE family IS NOT NULL`,
  );
  const map = new Map<string, GroupPredicate>();
  for (const r of res.rows) map.set(r.name, r.kind === "order" ? { orders: [r.name] } : { families: [r.name] });
  latinGroupCache = { at: Date.now(), map };
  return map;
}

// The last word of every catalog species' common name ("tiger", "fisher"). Cached like the Latin names.
let catalogHeadCache: { at: number; heads: Set<string> } | null = null;
async function catalogHeadNouns(): Promise<Set<string>> {
  if (catalogHeadCache && Date.now() - catalogHeadCache.at < 10 * 60_000) return catalogHeadCache.heads;
  const res = await pool.query<{ head: string }>(
    `SELECT DISTINCT lower(regexp_replace(common_name, '^.* ', '')) AS head
       FROM species WHERE common_name IS NOT NULL AND NOT is_other_taxa`,
  );
  catalogHeadCache = { at: Date.now(), heads: new Set(res.rows.map((r) => r.head)) };
  return catalogHeadCache.heads;
}

// A region and everything inside it, for a place named in a query.
async function regionSubtree(regionIds: string[]): Promise<Set<string>> {
  const res = await pool.query<{ id: string }>(
    `WITH RECURSIVE down AS (
       SELECT id FROM regions WHERE id = ANY($1::uuid[])
       UNION
       SELECT r.id FROM regions r JOIN down d ON r.parent_id = d.id
     )
     SELECT id::text AS id FROM down`,
    [regionIds],
  );
  return new Set(res.rows.map((r) => r.id));
}

const GallerySearchQuery = Type.Object({
  ...GalleryFilterQuery.properties,
  q: Type.Optional(Type.String({ description: 'What to look for, e.g. "bird in flight" or "costa rica trip"' })),
  // The page follows a quick answer up with the full search.
  quick: OnOff("1 to skip picture matching and answer at once"),
});

const GalleryListQuery = Type.Object({
  ...GalleryFilterQuery.properties,
  // Not an enum: the web app sends a sort remembered in the browser, and an unknown one has
  // always meant the default.
  sort: Type.Optional(
    Type.String({
      description:
        "newest (default), oldest, ratingHigh, ratingLow, taxonomic (field guide order), name (common name), scientific or rarity (rarest first)",
    }),
  ),
  // No maximum: a larger limit has always been capped at 500, not refused.
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Page size, 1 to 500 (default and cap 500; larger is capped)",
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: "nextCursor from the previous page, with the same sort and filters" }),
  ),
  allVersions: OnOff(
    "1 to also list every version of a photo (prints, edits, exports) as its own item, each with `version`. Counts elsewhere stay one per photo",
  ),
});

// The captures plus the versions hidden behind their photos (not ones the user hid as well).
const ALL_VERSIONS_SOURCE = `(SELECT * FROM captures_all c WHERE deleted_at IS NULL AND (hidden_at IS NULL OR EXISTS (
  SELECT 1 FROM capture_versions cv WHERE cv.capture_id = c.id AND cv.state = 'linked' AND cv.hid_capture)))`;
// A version used as the photo swapped photos with its group, so its card shows the group's own
// file: named after that file.
const SHOWN_FILE = `(SELECT cv.group_capture_id FROM capture_versions cv
  WHERE cv.capture_id = c.id AND cv.state = 'linked' AND cv.displayed)`;
const VERSION_COLUMNS = `,
  (SELECT cv.group_capture_id FROM capture_versions cv WHERE cv.capture_id = c.id AND cv.state = 'linked') AS version_of,
  (SELECT l.label FROM capture_version_labels l WHERE l.capture_id = COALESCE(${SHOWN_FILE}, c.id)) AS version_label,
  vf.ref AS version_ref, vf.role AS version_role`;
const VERSION_JOINS = `
  LEFT JOIN LATERAL (
    SELECT vo.ref, vo.role FROM originals vo WHERE vo.capture_id = COALESCE(${SHOWN_FILE}, c.id)
    ORDER BY (vo.kind = 'jpeg') DESC LIMIT 1
  ) vf ON true`;

/** A photo search within a filter set, best match first: what /gallery/search answers and what
 *  a smart album with search text lists. Null when `isGone` says the client left first. */
export async function searchGallery(
  userId: string,
  q: string,
  filters: GalleryFilters,
  opts: { quick?: boolean; isGone?: () => boolean; ignoreAlbumNames?: boolean } = {},
): Promise<SearchOutcome<GallerySearchRow> | null> {
  const quick = opts.quick ?? false;
  const stamp = await libraryStamp(userId);
  // LEFT JOIN: a photo without a vector or scene is still found by name, group, place and date.
  const rowsFor = (f: GalleryFilters) => {
    const params: unknown[] = [userId, EMBEDDING_MODEL_VERSION, SCENE_MODEL_VERSION];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = galleryFilterSql(f, param);
    return searchRows(
      userId,
      stamp,
      `SELECT ${GALLERY_ITEM_COLUMNS}${galleryLocalTierColumn(f, param)},
            c.location_label, c.trip_id::text AS trip_id, s.common_name_aliases, s.aba_code, s.ebird_code,
            (SELECT array_agg(ac.album_id::text) FROM album_captures ac WHERE ac.capture_id = c.id) AS album_ids,
            ce.computed_at::text AS embedding_computed_at, cs.labels AS scene_labels, cs.colors AS scene_colors,
            c.subject_count, cbg.computed_at::text AS background_computed_at,
            -- A lifer is a photo from the day the species was first photographed. first_collected
            -- is a date, so the photo's time has to go first.
            (c.taken_at::date = us.first_collected) IS TRUE AS is_lifer,
            EXISTS (SELECT 1 FROM species_traits t WHERE t.species_id = c.species_id
                      AND (t.endemic_country_iso3 IS NOT NULL OR t.endemic_region_label IS NOT NULL)) AS is_endemic
       FROM ${galleryCapturesSource(f)} c
       ${GALLERY_ITEM_FRAME_JOINS}
       LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $2
       LEFT JOIN capture_scenes cs ON cs.capture_id = c.id AND cs.model_version = $3
       LEFT JOIN capture_background_embeddings cbg
         ON cbg.capture_id = c.id AND cbg.photo_id = p.id AND cbg.model_version = $2
       WHERE c.user_id = $1
         ${where}`,
      params,
    );
  };
  const [res, vocab, latinGroups, catalogHeads] = await Promise.all([
    rowsFor(filters),
    searchVocabulary(userId, stamp),
    latinGroupNames(),
    catalogHeadNouns(),
  ]);

  const speciesById = new Map<string, SpeciesEntry>();
  for (const r of res.rows) {
    if (speciesById.has(r.species_id)) continue;
    speciesById.set(r.species_id, {
      id: r.species_id,
      commonName: r.common_name,
      scientificName: r.scientific_name,
      taxonClass: r.taxon_class,
      taxonOrder: r.taxon_order,
      family: r.family,
      // Old scientific names (species_synonyms) match the same way an alias does.
      aliases: [...((r.common_name_aliases as string[] | null) ?? []), ...(vocab.synonyms.get(r.species_id) ?? [])],
      codes: [r.aba_code, r.ebird_code].filter((c): c is string => typeof c === "string" && c.length > 0),
    });
  }
  const cameras = [...new Set(res.rows.map((r) => r.camera_model).filter((m): m is string => !!m))];
  const parsed = parseSearchQuery(
    q,
    {
      species: [...speciesById.values()],
      places: opts.ignoreAlbumNames ? vocab.places.filter((p) => p.kind !== "album") : vocab.places,
      latinGroups,
      catalogHeads,
      cameras,
    },
    { partialWordPicksSpecies: quick },
  );
  // Filter words in the query ("5 stars", "videos", "hidden") work as the Gallery's own filters.
  const narrowed = withQueryFilters(filters, parsed);
  if (narrowed !== filters) await withShotTypeIds(narrowed, userId);
  const rows = narrowed === filters ? res.rows : (await rowsFor(narrowed)).rows;
  // The full pass embeds the description with CLIP; not worth doing for a cancelled request.
  if (!quick && (parsed.description || parsed.scenes.length > 0) && opts.isGone?.()) return null;
  return rankSearch(q, parsed, rows, regionSubtree, { quick });
}

/** The filters with the query's filter words added. They only narrow what's already checked: a
 *  shot type word narrows its axis to that one when the filter already allows it. */
function withQueryFilters(f: GalleryFilters, parsed: Pick<ParsedQuery, "readings" | "stars">): GalleryFilters {
  const r = parsed.readings;
  const stars = parsed.stars;
  const narrowAxis = <T extends string>(checked: T[], known: readonly T[]) => {
    const typed = known.filter((k) => r.has(k as Reading));
    if (typed.length === 0) return checked;
    const kept = checked.length === 0 ? typed : typed.filter((k) => checked.includes(k));
    // Nothing allowed both ways: nothing matches, which an unknown value says.
    return kept.length > 0 ? kept : (["none"] as T[]);
  };
  const shotActions = narrowAxis(f.shotActions, SHOT_ACTIONS);
  const shotFramings = narrowAxis(f.shotFramings, SHOT_FRAMINGS);
  if (
    !stars &&
    shotActions === f.shotActions &&
    shotFramings === f.shotFramings &&
    !["unrated", "videos", "raw", "hidden", "edited", "noDate"].some((k) => r.has(k as Reading))
  )
    return f;
  return {
    ...f,
    ratingMin: stars ? Math.max(f.ratingMin ?? 0, stars.min) : f.ratingMin,
    ratingMax: stars?.max ? Math.min(f.ratingMax ?? 5, stars.max) : f.ratingMax,
    unrated: f.unrated || r.has("unrated"),
    onlyVideo: f.onlyVideo || r.has("videos"),
    onlyHasRaw: f.onlyHasRaw || r.has("raw"),
    onlyHidden: f.onlyHidden || r.has("hidden"),
    // Edited photos are the ones with more than a RAW, as the RAW files filter's "Hide" shows.
    includeRaw: f.includeRaw && !r.has("edited"),
    missingDate: f.missingDate || r.has("noDate"),
    shotActions,
    shotFramings,
  };
}

/** Every photo a filter set matches, in the Gallery's default order (newest first). `columns`
 *  narrows the select for callers that only need ids, which skips the per-row subqueries. */
export async function listGalleryRows<T = GalleryRow>(
  userId: string,
  filters: GalleryFilters,
  columns = GALLERY_ITEM_COLUMNS,
): Promise<T[]> {
  const params: unknown[] = [userId];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = galleryFilterSql(filters, param);
  const localTier = columns === GALLERY_ITEM_COLUMNS ? galleryLocalTierColumn(filters, param) : "";
  const res = await pool.query(
    `SELECT ${columns}${localTier}
       FROM ${galleryCapturesSource(filters)} c
       ${GALLERY_ITEM_FRAME_JOINS}
       WHERE c.user_id = $1
         ${where}
       ORDER BY ${galleryOrderBy(GALLERY_SORTS.newest)}`,
    params,
  );
  return res.rows as T[];
}

const forViewer = <T extends { captureId: string; lat: unknown; lon: unknown }>(
  item: T,
  sensitive: Set<string> | null,
  device: boolean | undefined,
) => (sensitive && device ? galleryItemForDevice(item, sensitive) : withoutSensitivePlace(item, sensitive));

export async function galleryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/gallery/search",
    {
      preValidation: requireScope("gallery.read", ["companion"]),
      schema: {
        querystring: GallerySearchQuery,
        response: replies(
          Type.Object({
            items: Type.Array(GalleryItem),
            interpretation: Type.Optional(SearchInterpretation),
            pending: Type.Optional(Type.Boolean()),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const q = request.query.q?.trim();
      // The same filters as /gallery, so a search never widens past what's already checked.
      const filters = await galleryFiltersFor(request.query, userId);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });
      if (!q) return { items: [] };
      const outcome = await searchGallery(userId, q, filters, {
        quick: request.query.quick === "1",
        isGone: watchClientGone(request, reply),
      });
      if (!outcome) return reply.code(499).send({ error: "Search cancelled" });
      const sensitive = await sensitiveForKey(
        request,
        outcome.items.map((o) => o.row),
      );
      return {
        items: outcome.items.map(({ row, score }) =>
          forViewer(toGalleryItem(row, score), sensitive, request.deviceKey),
        ),
        interpretation: outcome.interpretation,
        pending: outcome.pending ?? false,
      };
    },
  );

  app.get(
    "/gallery",
    {
      preValidation: requireScope("gallery.read", ["companion"]),
      schema: {
        querystring: GalleryListQuery,
        response: replies(
          Type.Object({
            items: Type.Array(GalleryItem),
            nextCursor: Type.Union([Type.String(), Type.Null()], {
              description: "Pass as cursor for the next page; null on the last page",
            }),
            total: Type.Optional(
              Type.Integer({
                description: "Only on the first page (no cursor): how many photos match the filters in all",
              }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const filters = await galleryFiltersFor(request.query, userId);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });
      const sortName = request.query.sort && GALLERY_SORTS[request.query.sort] ? request.query.sort : "newest";
      const sortKeys = GALLERY_SORTS[sortName];

      // Keyset paging, always: one page of up to 500 plus nextCursor.
      const limit = parseLimit(request.query.limit, 500, 500);
      let cursor: GalleryCursor | null = null;
      if (request.query.cursor) {
        cursor = decodeGalleryCursor(request.query.cursor);
        if (!cursor || cursor.sort !== sortName) return reply.code(400).send({ error: "Invalid cursor" });
      }

      const params: unknown[] = [userId];
      const param = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const where = galleryFilterSql(filters, param);
      // The filter params only, captured before the cursor adds its own, for the first page's count.
      const filterParams = [...params];
      const allVersions = request.query.allVersions === "1" && !filters.onlyHidden;
      const source = allVersions ? ALL_VERSIONS_SOURCE : galleryCapturesSource(filters);
      const localTier = galleryLocalTierColumn(filters, param) + (allVersions ? VERSION_COLUMNS : "");
      const after = cursor ? galleryAfterCursorSql(sortKeys, cursor, param) : "";
      // Counted on the first page only.
      const countQuery = !cursor
        ? pool.query<{ total: number }>(
            `SELECT count(*)::int AS total
               FROM ${source} c
               ${GALLERY_ITEM_JOINS}
               WHERE c.user_id = $1
                 ${where}`,
            filterParams,
          )
        : null;
      const [res, countRes] = await Promise.all([
        pool.query(
          `SELECT ${GALLERY_ITEM_COLUMNS}${localTier}, ${sortKeys.map((k, i) => `(${k.expr})::text AS _sort${i}`).join(", ")}
           FROM ${source} c
           ${GALLERY_ITEM_FRAME_JOINS}${allVersions ? VERSION_JOINS : ""}
           WHERE c.user_id = $1
             ${where}
             ${after}
           ORDER BY ${galleryOrderBy(sortKeys)}
           LIMIT ${limit + 1}`,
          params,
        ),
        countQuery,
      ]);

      const page = res.rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        res.rows.length > limit && last
          ? encodeGalleryCursor({
              sort: sortName,
              values: sortKeys.map((_, i) => last[`_sort${i}`] ?? null),
              id: last.capture_id,
            })
          : null;
      const sensitive = await sensitiveForKey(request, page);
      const total = countRes ? (countRes.rows[0]?.total ?? 0) : undefined;
      return {
        items: page.map((row) => {
          const item = forViewer(toGalleryItem(row, null), sensitive, request.deviceKey);
          if (!row.version_of) return item;
          const auto = versionLabel(row.version_ref ?? "", row.version_role ?? null);
          return {
            ...item,
            version: {
              of: row.version_of,
              label: row.version_label ?? null,
              labelKind: auto.kind,
              labelSize: auto.size,
            },
          };
        }),
        nextCursor,
        ...(total !== undefined ? { total } : {}),
      };
    },
  );

  // Every capture id the /gallery filters match, so select all needn't page through full items.
  // Video and RAW ids come along for the batch actions that word or offer things by them.
  app.get(
    "/gallery/ids",
    {
      preValidation: requireScope("gallery.read"),
      schema: {
        querystring: Type.Object({
          ...GalleryFilterQuery.properties,
          originals: Type.Optional(
            Type.Boolean({ description: "Also list each photo's downloadable original, for downloading them all" }),
          ),
        }),
        response: replies(
          Type.Object({
            captureIds: Type.Array(Uuid()),
            videoCaptureIds: Type.Array(Uuid()),
            rawCaptureIds: Type.Array(Uuid()),
            locatedCaptureIds: Type.Array(Uuid(), { description: "The ones with coordinates" }),
            originals: Type.Optional(
              Type.Array(Type.Object({ captureId: Uuid(), photoId: Uuid(), kind: Type.String() }), {
                description: "With originals=true: the photos that have one, and its kind",
              }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const filters = await galleryFiltersFor(request.query, userId);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });
      const params: unknown[] = [userId];
      const param = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const where = galleryFilterSql(filters, param);
      const res = await pool.query<{
        capture_id: string;
        is_video: boolean;
        has_raw: boolean;
        photo_id: string;
        original_kind: string | null;
        has_original: boolean;
        located: boolean;
      }>(
        `SELECT c.id::text AS capture_id, p.kind = 'video' AS is_video, c.lat IS NOT NULL AND c.lon IS NOT NULL AS located,
              p.id::text AS photo_id, o.kind AS original_kind, o.ref IS NOT NULL AS has_original,
              -- A RAW beside an edited original: the delete dialog's "also delete the RAW" choice.
              -- A RAW-only photo is its RAW, so it goes when the photo does.
              EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')
                AND EXISTS (SELECT 1 FROM originals eo WHERE eo.capture_id = c.id AND eo.kind <> 'raw') AS has_raw
         FROM ${galleryCapturesSource(filters)} c
         ${GALLERY_ITEM_JOINS}
         WHERE c.user_id = $1
           ${where}`,
        params,
      );
      const captureIds: string[] = [];
      const videoCaptureIds: string[] = [];
      const rawCaptureIds: string[] = [];
      const locatedCaptureIds: string[] = [];
      const originals: Array<{ captureId: string; photoId: string; kind: string }> = [];
      for (const r of res.rows) {
        captureIds.push(r.capture_id);
        if (r.is_video) videoCaptureIds.push(r.capture_id);
        if (r.has_raw) rawCaptureIds.push(r.capture_id);
        if (r.located) locatedCaptureIds.push(r.capture_id);
        if (r.has_original && r.original_kind)
          originals.push({ captureId: r.capture_id, photoId: r.photo_id, kind: r.original_kind });
      }
      return {
        captureIds,
        videoCaptureIds,
        rawCaptureIds,
        locatedCaptureIds,
        ...(request.query.originals ? { originals } : {}),
      };
    },
  );

  // Whether the user has any video, so the "Video" filter only shows when useful.
  app.get(
    "/gallery/has-video",
    {
      preValidation: requireScope("gallery.read"),
      schema: { response: replies(Type.Object({ hasVideo: Type.Boolean(), hasAudio: Type.Boolean() })) },
    },
    async (request) => {
      const userId = request.user!.id;
      const res = await pool.query<{ video: boolean; audio: boolean }>(
        `SELECT EXISTS (
         SELECT 1 FROM photos p JOIN captures c ON c.id = p.capture_id
         WHERE c.user_id = $1 AND p.kind = 'video'
       ) AS video, EXISTS (
         SELECT 1 FROM photos p JOIN captures c ON c.id = p.capture_id
         WHERE c.user_id = $1 AND p.kind = 'audio'
       ) AS audio`,
        [userId],
      );
      return { hasVideo: res.rows[0]?.video ?? false, hasAudio: res.rows[0]?.audio ?? false };
    },
  );

  // Groups of near-identical photos (bursts and repeats) for review, largest first. Each opens in
  // the Gallery with ?similarTo= its first photo.
  app.get(
    "/gallery/similar",
    {
      preValidation: requireScope("gallery.read"),
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.String({ pattern: "^[0-9]+$", description: "Groups per page, up to 200" })),
          offset: Type.Optional(Type.String({ pattern: "^[0-9]+$", description: "Groups to skip" })),
        }),
        response: replies(SimilarGroupList),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const limit = parseLimit(request.query.limit, 100, 200);
      const offset = Number(request.query.offset ?? 0);
      const all = await similarGroups(userId);
      const page = all.slice(offset, offset + limit);
      const ids = page.flatMap((g) => [...g.slice(0, SIMILAR_PREVIEWS), g[g.length - 1]]);
      const res = await pool.query<{
        id: string;
        photo_id: string | null;
        taken_at: Date | null;
        species_id: string;
        common_name: string | null;
        scientific_name: string;
      }>(
        `SELECT c.id, c.current_photo_id AS photo_id, c.taken_at, c.species_id, s.common_name, s.scientific_name
           FROM captures c JOIN species s ON s.id = c.species_id
          WHERE c.user_id = $1 AND c.id = ANY($2::uuid[])`,
        [userId, ids],
      );
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      return {
        total: all.length,
        groups: page.flatMap((g) => {
          const first = byId.get(g[0]);
          // Trashed or hidden since the groups were worked out.
          if (!first) return [];
          return [
            {
              captureId: g[0],
              count: g.length,
              speciesId: first.species_id,
              commonName: first.common_name,
              scientificName: first.scientific_name,
              firstTakenAt: first.taken_at?.toISOString() ?? null,
              lastTakenAt: byId.get(g[g.length - 1])?.taken_at?.toISOString() ?? null,
              previewPhotoIds: g
                .slice(0, SIMILAR_PREVIEWS)
                .map((id) => byId.get(id)?.photo_id)
                .filter((id): id is string => !!id),
            },
          ];
        }),
      };
    },
  );

  // "Keep all" and "Not similar": the photo's group is never offered again. The reply lists the
  // photos, which the DELETE below takes to bring the group back.
  app.post(
    "/gallery/similar/dismiss",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ captureId: Uuid() }, { additionalProperties: false }),
        response: replies(Type.Object({ captureIds: Type.Array(Uuid()) })),
      },
    },
    async (request) => ({ captureIds: await dismissSimilarGroup(request.user!.id, request.body.captureId) }),
  );

  app.delete(
    "/gallery/similar/dismiss",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 2, maxItems: 500 }) },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      await setDismissed(request.user!.id, request.body.captureIds, false);
      return { ok: true };
    },
  );

  // Taxon classes the user has photographed, so the Taxon filter never offers empty choices.
  app.get(
    "/gallery/taxa",
    {
      preValidation: requireScope("gallery.read"),
      // Nullable: a species without a class still shows up here as null.
      schema: { response: replies(Type.Object({ taxa: Type.Array(Type.Union([Type.String(), Type.Null()])) })) },
    },
    async (request) => {
      const userId = request.user!.id;
      const res = await pool.query<{ taxon_class: string }>(
        `SELECT DISTINCT s.taxon_class
         FROM captures c
         JOIN species s ON s.id = c.species_id
         WHERE c.user_id = $1`,
        [userId],
      );
      return { taxa: res.rows.map((r) => r.taxon_class) };
    },
  );

  // Regions the Region filter offers: those with photos, plus their ancestors so the tree can
  // be drilled down to them.
  app.get(
    "/gallery/regions-with-photos",
    {
      preValidation: requireScope("gallery.read"),
      schema: { response: replies(Type.Object({ regionIds: Type.Array(Uuid()) })) },
    },
    async (request) => {
      const userId = request.user!.id;
      const res = await pool.query<{ id: string }>(
        `WITH RECURSIVE used AS (
         SELECT DISTINCT region_id AS id FROM captures WHERE user_id = $1 AND region_id IS NOT NULL
       ),
       ancestors AS (
         SELECT id FROM used
         UNION
         SELECT r.parent_id FROM regions r JOIN ancestors a ON r.id = a.id WHERE r.parent_id IS NOT NULL
       )
       SELECT DISTINCT id FROM ancestors`,
        [userId],
      );
      return { regionIds: res.rows.map((r) => r.id) };
    },
  );
}

/** A row of GALLERY_ITEM_COLUMNS. */
export interface GalleryRow {
  photo_id: string;
  width: number | null;
  height: number | null;
  capture_id: string;
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string;
  taken_at: Date | null;
  camera_model: string | null;
  lens: string | null;
  focal_length_mm: string | null;
  aperture: string | null;
  shutter: string | null;
  iso: number | null;
  quality_rating: number | null;
  lat: string | null;
  lon: string | null;
  region_id: string | null;
  region_name: string | null;
  location_label: string | null;
  photo_kind: "image" | "video" | "audio" | null;
  duration_seconds: string | null;
  tags: string[] | null;
  cull_verdict: "pick" | "reject" | null;
  cull_label: CullLabel | null;
  hidden: boolean | null;
  is_featured: boolean | null;
  has_raw_original: boolean;
  inat_status: "pending" | "completed" | null;
  inat_observation_id: string | null;
  original_ref: string | null;
  original_managed: boolean | null;
  original_kind: string | null;
  raw_ref: string | null;
  taxon_order: string | null;
  family: string | null;
  sort_order: number | null;
  is_other_taxa: boolean | null;
  inat_iconic_taxon: string | null;
  tier: string | null;
  /** Only selected with a region filter (galleryLocalTierColumn). */
  local_tier?: string | null;
  frame_box: number[] | null;
  frame_unsure: boolean | null;
  frame_aspect: number | null;
  light_stats: LightStats | null;
  taken_at_zoned: boolean | null;
}

/** What search reads from a photo's frame, in API form (GalleryItem.frame). Null until read. */
function frameItem(row: GalleryRow) {
  if (row.frame_aspect == null || !row.light_stats) return null;
  const box = row.frame_box?.length === 4 ? (row.frame_box as FrameBox) : null;
  return {
    box,
    boxUnsure: !!row.frame_unsure,
    aspect: row.frame_aspect,
    orientation: orientationOf(row.frame_aspect),
    composition: box && !row.frame_unsure ? compositionOf(box) : null,
    light: row.light_stats,
  };
}

// Response shape for /gallery and /gallery/search; score is null for the plain listing.
export function toGalleryItem(row: GalleryRow, score: number | null) {
  return {
    photoId: row.photo_id,
    width: row.width,
    height: row.height,
    captureId: row.capture_id,
    speciesId: row.species_id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    taxonClass: row.taxon_class,
    takenAt: row.taken_at,
    cameraModel: row.camera_model,
    lens: row.lens,
    focalLengthMm: row.focal_length_mm,
    aperture: row.aperture,
    shutter: row.shutter,
    iso: row.iso,
    qualityRating: row.quality_rating,
    lat: row.lat,
    lon: row.lon,
    regionId: row.region_id,
    regionName: row.region_name,
    locationLabel: row.location_label ?? null,
    kind: row.photo_kind ?? "image",
    durationSeconds: row.duration_seconds,
    tags: row.tags ?? [],
    // What a culling app marked the photo (shown in the lightbox's info), and whether it was
    // imported hidden.
    cullVerdict: row.cull_verdict ?? null,
    cullLabel: row.cull_label ?? null,
    hidden: row.hidden ?? false,
    isFeatured: row.is_featured,
    hasRawOriginal: row.has_raw_original,
    inatStatus: row.inat_status,
    inatObservationId: row.inat_observation_id,
    originalRef: row.original_ref,
    originalManaged: row.original_managed,
    originalKind: row.original_kind,
    rawRef: row.raw_ref ?? null,
    taxonOrder: row.taxon_order,
    family: row.family,
    sortOrder: row.sort_order ?? null,
    isOtherTaxa: row.is_other_taxa === true,
    inatIconicTaxon: row.inat_iconic_taxon,
    tier: row.tier,
    localTier: row.local_tier ?? null,
    matchScore: score,
    frame: frameItem(row),
    // Sun well down but a plainly daylit photo: the bulk date fix can suggest it.
    timeMaybeWrong: row.light_stats ? timeMaybeWrong(trustedSun(row), row.light_stats) : null,
  };
}
