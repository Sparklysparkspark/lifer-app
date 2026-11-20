// Reads that the Collection, Gallery, Albums, Trips and Stats screens need on top of the base store.
// Everything here is a local read; nothing writes.
import { TIER_ORDER } from "@lifer/shared";
import type { Db, Param } from "./db";
import type { GridPhoto } from "./library";
import { toCrop, type Crop } from "../photos/crop";
import { SPECIES_SQL, speciesFrom, type RawSpecies, type SpeciesRow } from "./marks";

export interface CollectionSpecies extends SpeciesRow {
  vagrant: boolean;
}

/** Every species of a kept region (or every species the phone knows, for Everywhere), with its status. */
export async function listCollection(db: Db, regionKey: string | null): Promise<CollectionSpecies[]> {
  const rows = await db.all<RawSpecies & { vagrant: number }>(
    regionKey
      ? `SELECT x.*, COALESCE((SELECT r.vagrant FROM region_species r WHERE r.region_key = ? AND r.scientific_name = x.scientific_name), 0) AS vagrant
         FROM (${SPECIES_SQL}) x
         WHERE EXISTS (SELECT 1 FROM region_species r WHERE r.region_key = ? AND r.scientific_name = x.scientific_name)`
      : `SELECT x.*, COALESCE((SELECT max(r.vagrant) FROM region_species r WHERE r.scientific_name = x.scientific_name), 0) AS vagrant
         FROM (${SPECIES_SQL}) x`,
    regionKey ? [regionKey, regionKey] : [],
  );
  return rows.map((r) => ({ ...speciesFrom(r), vagrant: !!r.vagrant }));
}

/** Years with at least one photo, newest first. */
export async function photoYears(db: Db): Promise<string[]> {
  return (
    await db.all<{ y: string }>(
      `SELECT DISTINCT substr(taken_at, 1, 4) AS y FROM captures WHERE photo_id IS NOT NULL AND hidden = 0 AND taken_at IS NOT NULL
       ORDER BY y DESC`,
    )
  ).map((r) => r.y);
}

export async function speciesPhotographedIn(db: Db, year: string): Promise<Set<string>> {
  return new Set(
    (
      await db.all<{ scientific_name: string }>(
        "SELECT DISTINCT scientific_name FROM captures WHERE hidden = 0 AND photo_id IS NOT NULL AND substr(taken_at, 1, 4) = ?",
        [year],
      )
    ).map((r) => r.scientific_name),
  );
}

export interface ShapedPhoto extends GridPhoto {
  width: number | null;
  height: number | null;
  /** The species name, for the tile's spoken label. */
  name: string | null;
}

export interface LibraryFilter {
  favourites?: boolean;
  /** Taxon classes of one broad group. */
  taxonClasses?: string[];
  tripId?: string;
  year?: string;
}

/** The library newest first with each photo's shape and species, narrowed by the Gallery's filters. */
export function libraryShapes(db: Db, filter: LibraryFilter = {}, limit = -1): Promise<ShapedPhoto[]> {
  const where: string[] = ["c.photo_id IS NOT NULL", "c.hidden = 0", "c.kind = 'image'"];
  const params: Param[] = [];
  if (filter.favourites)
    where.push(
      `c.id IN (SELECT ac.capture_id FROM album_captures ac JOIN albums a ON a.id = ac.album_id WHERE lower(a.name) IN ('favourites', 'favorites'))`,
    );
  if (filter.taxonClasses) {
    where.push(`c.scientific_name IN (SELECT scientific_name FROM species WHERE taxon_class IN (${filter.taxonClasses.map(() => "?").join(",") || "NULL"}))`);
    params.push(...filter.taxonClasses);
  }
  if (filter.tripId) {
    where.push("c.trip_id = ?");
    params.push(filter.tripId);
  }
  if (filter.year) {
    where.push("substr(c.taken_at, 1, 4) = ?");
    params.push(filter.year);
  }
  return db.all<ShapedPhoto>(
    `SELECT c.photo_id AS photoId, c.taken_at AS takenAt, c.width, c.height, COALESCE(sp.common_name, c.scientific_name) AS name
     FROM captures c LEFT JOIN species sp ON sp.scientific_name = c.scientific_name
     WHERE ${where.join(" AND ")} ORDER BY c.taken_at IS NULL, c.taken_at DESC, c.id LIMIT ?`,
    [...params, limit],
  );
}

/** The place most photos of each month were taken, for the month headings ("May 2026, Tofino"). */
export async function monthPlaces(db: Db): Promise<Record<string, string>> {
  const rows = await db.all<{ m: string; place: string; n: number }>(
    `SELECT substr(taken_at, 1, 7) AS m, location_label AS place, count(*) AS n FROM captures
     WHERE photo_id IS NOT NULL AND hidden = 0 AND taken_at IS NOT NULL AND location_label IS NOT NULL AND location_label <> ''
     GROUP BY m, place ORDER BY m, n DESC`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.m] ??= r.place;
  return out;
}

export interface PhotoInfo {
  captureId: string;
  scientificName: string;
  takenAt: string | null;
  place: string | null;
  tags: string[];
  trip: { id: string; name: string } | null;
  albums: string[];
}

export async function photoInfo(db: Db, photoId: string): Promise<PhotoInfo | null> {
  const c = await db.get<{ id: string; scientific_name: string; taken_at: string | null; location_label: string | null; tags: string; trip_id: string | null }>(
    "SELECT id, scientific_name, taken_at, location_label, tags, trip_id FROM captures WHERE photo_id = ? LIMIT 1",
    [photoId],
  );
  if (!c) return null;
  const trip = c.trip_id ? await db.get<{ id: string; name: string }>("SELECT id, name FROM trips WHERE id = ?", [c.trip_id]) : null;
  const albums = await db.all<{ name: string }>(
    "SELECT a.name FROM albums a JOIN album_captures ac ON ac.album_id = a.id WHERE ac.capture_id = ? ORDER BY a.name COLLATE NOCASE",
    [c.id],
  );
  return {
    captureId: c.id,
    scientificName: c.scientific_name,
    takenAt: c.taken_at,
    place: c.location_label,
    tags: JSON.parse(c.tags || "[]") as string[],
    trip,
    albums: albums.map((a) => a.name),
  };
}

export interface AlbumRow {
  id: string;
  name: string;
  count: number;
  coverPhotoId: string | null;
  /** The crop of the cover the user chose; none when Lifer picked the cover. */
  coverCrop: Crop | null;
  favourites: boolean;
}

export async function listAlbums(db: Db): Promise<AlbumRow[]> {
  const rows = await db.all<{
    id: string;
    name: string;
    cover: string | null;
    chosen: string | null;
    cx: number | null;
    cy: number | null;
    cs: number | null;
    n: number;
  }>(
    `SELECT a.id, a.name, a.cover_photo_id AS chosen, a.cover_crop_x AS cx, a.cover_crop_y AS cy, a.cover_crop_size AS cs,
       COALESCE((SELECT c.photo_id FROM captures c WHERE c.photo_id = a.cover_photo_id AND c.hidden = 0),
                (SELECT c.photo_id FROM album_captures ac JOIN captures c ON c.id = ac.capture_id
                  WHERE ac.album_id = a.id AND c.photo_id IS NOT NULL AND c.hidden = 0 AND c.kind = 'image'
                  ORDER BY c.rating DESC, c.taken_at DESC LIMIT 1)) AS cover,
       (SELECT count(*) FROM album_captures ac JOIN captures c ON c.id = ac.capture_id
          WHERE ac.album_id = a.id AND c.photo_id IS NOT NULL AND c.hidden = 0) AS n
     FROM albums a`,
  );
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      count: Number(r.n),
      coverPhotoId: r.cover,
      coverCrop: r.cover && r.cover === r.chosen ? toCrop(r.cx, r.cy, r.cs) : null,
      favourites: ["favourites", "favorites"].includes(r.name.trim().toLowerCase()),
    }))
    .sort((a, b) => Number(b.favourites) - Number(a.favourites) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export const albumPhotos = (db: Db, albumId: string): Promise<GridPhoto[]> =>
  db.all<GridPhoto>(
    `SELECT c.photo_id AS photoId, c.taken_at AS takenAt FROM album_captures ac JOIN captures c ON c.id = ac.capture_id
     WHERE ac.album_id = ? AND c.photo_id IS NOT NULL AND c.hidden = 0 AND c.kind = 'image'
     ORDER BY c.taken_at IS NULL, c.taken_at DESC, c.id`,
    [albumId],
  );

export interface SpeciesFacts {
  firstPhotographed: string | null;
  lastSeen: string | null;
  photos: number;
}

export async function speciesFacts(db: Db, scientificName: string): Promise<SpeciesFacts> {
  const c = await db.get<{ first: string | null; last: string | null; n: number }>(
    `SELECT min(taken_at) AS first, max(taken_at) AS last, count(*) AS n FROM captures
     WHERE scientific_name = ? AND hidden = 0 AND photo_id IS NOT NULL`,
    [scientificName],
  );
  return { firstPhotographed: c?.first ?? null, lastSeen: c?.last ?? null, photos: Number(c?.n ?? 0) };
}

/** A thumbnail photo for each trip: its cover capture, else its best photo. */
export async function tripCovers(db: Db): Promise<Record<string, string>> {
  const rows = await db.all<{ id: string; cover: string | null }>(
    `SELECT t.id, COALESCE((SELECT c.photo_id FROM captures c WHERE c.id = t.cover_capture_id AND c.photo_id IS NOT NULL),
       (SELECT c.photo_id FROM captures c WHERE c.trip_id = t.id AND c.photo_id IS NOT NULL AND c.hidden = 0 AND c.kind = 'image'
          ORDER BY c.rating DESC, c.taken_at DESC LIMIT 1)) AS cover FROM trips t`,
  );
  return Object.fromEntries(rows.filter((r) => r.cover).map((r) => [r.id, r.cover as string]));
}

/** The crop of each trip's chosen cover photo (trips whose cover Lifer picked have none). */
export async function tripCoverCrops(db: Db): Promise<Record<string, Crop>> {
  const rows = await db.all<{ id: string; cx: number | null; cy: number | null; cs: number | null }>(
    `SELECT t.id, t.cover_crop_x AS cx, t.cover_crop_y AS cy, t.cover_crop_size AS cs FROM trips t
     WHERE EXISTS (SELECT 1 FROM captures c WHERE c.id = t.cover_capture_id AND c.photo_id IS NOT NULL)`,
  );
  return Object.fromEntries(rows.flatMap((r) => { const c = toCrop(r.cx, r.cy, r.cs); return c ? [[r.id, c]] : []; }));
}

export type PhotosToCount = "all" | "featured" | "top";

const COUNTED: Record<PhotosToCount, string> = {
  all: "",
  featured: "AND c.photo_id IN (SELECT cover_photo_id FROM marks WHERE cover_photo_id IS NOT NULL)",
  top: "AND c.rating >= 4",
};

export interface Stats {
  photographed: number;
  seenOnly: number;
  photos: number;
  regions: number;
  byGroup: { taxonClass: string | null; n: number }[];
  byYear: { year: string; n: number }[];
  mostPhotographed: { scientificName: string; commonName: string | null; n: number }[];
  oneAndDone: { scientificName: string; commonName: string | null }[];
  oneAndDoneCount: number;
}

export async function stats(db: Db, count: PhotosToCount): Promise<Stats> {
  const where = `c.hidden = 0 AND c.photo_id IS NOT NULL ${COUNTED[count]}`;
  const num = async (sql: string, params: Param[] = []) => Number((await db.get<{ n: number }>(sql, params))?.n ?? 0);
  const photographed = await num(`SELECT count(DISTINCT c.scientific_name) AS n FROM captures c WHERE ${where}`);
  const photos = await num(`SELECT count(*) AS n FROM captures c WHERE ${where}`);
  const seenOnly = await num(
    `SELECT count(*) AS n FROM marks m WHERE m.state = 'seen'
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.scientific_name = m.scientific_name AND c.hidden = 0 AND c.photo_id IS NOT NULL)`,
  );
  const regions = await num("SELECT count(*) AS n FROM regions");
  const byGroup = await db.all<{ taxonClass: string | null; n: number }>(
    `SELECT sp.taxon_class AS taxonClass, count(*) AS n FROM species sp
     WHERE sp.scientific_name IN (SELECT c.scientific_name FROM captures c WHERE ${where}) GROUP BY sp.taxon_class`,
  );
  const byYear = await db.all<{ year: string; n: number }>(
    `SELECT substr(first, 1, 4) AS year, count(*) AS n FROM
       (SELECT min(c.taken_at) AS first FROM captures c WHERE ${where} AND c.taken_at IS NOT NULL GROUP BY c.scientific_name)
     GROUP BY year ORDER BY year`,
  );
  const mostPhotographed = await db.all<{ scientificName: string; commonName: string | null; n: number }>(
    `SELECT c.scientific_name AS scientificName, sp.common_name AS commonName, count(*) AS n FROM captures c
     LEFT JOIN species sp ON sp.scientific_name = c.scientific_name WHERE ${where}
     GROUP BY c.scientific_name ORDER BY n DESC, c.scientific_name LIMIT 5`,
  );
  const one = `FROM (SELECT c.scientific_name AS s FROM captures c WHERE ${where} GROUP BY c.scientific_name HAVING count(*) = 1) o
     LEFT JOIN species sp ON sp.scientific_name = o.s`;
  const oneAndDone = await db.all<{ scientificName: string; commonName: string | null }>(
    `SELECT o.s AS scientificName, sp.common_name AS commonName ${one} ORDER BY COALESCE(sp.common_name, o.s) COLLATE NOCASE LIMIT 5`,
  );
  const oneAndDoneCount = await num(`SELECT count(*) AS n ${one}`);
  return {
    photographed,
    seenOnly,
    photos,
    regions,
    byGroup: byGroup.map((r) => ({ taxonClass: r.taxonClass, n: Number(r.n) })),
    byYear: byYear.map((r) => ({ year: r.year, n: Number(r.n) })),
    mostPhotographed: mostPhotographed.map((r) => ({ ...r, n: Number(r.n) })),
    oneAndDone,
    oneAndDoneCount,
  };
}

export interface NearTarget {
  scientificName: string;
  commonName: string | null;
  taxonClass: string | null;
  coverPhotoId: string | null;
}

/** Targets not yet seen or photographed, from the given regions (every kept region when none are given). */
export async function nearTargets(db: Db, keys: string[] | null, limit: number): Promise<NearTarget[]> {
  const only = keys && keys.length ? `AND m.scientific_name IN (SELECT scientific_name FROM region_species WHERE region_key IN (${keys.map(() => "?").join(",")}))` : "";
  return db.all<NearTarget>(
    `SELECT sp.scientific_name AS scientificName, sp.common_name AS commonName, sp.taxon_class AS taxonClass, NULL AS coverPhotoId
     FROM marks m JOIN species sp ON sp.scientific_name = m.scientific_name
     WHERE m.is_target = 1 AND m.state IS NULL ${only}
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.scientific_name = m.scientific_name AND c.hidden = 0)
     ORDER BY COALESCE(sp.common_name, sp.scientific_name) COLLATE NOCASE LIMIT ?`,
    [...(keys && keys.length ? keys : []), limit],
  );
}

/**
 * The person's targets on a region's checklist (every kept region when none given) not yet photographed:
 * seen ones first, then never seen, each by difficulty tier (hardest first) then name. No location is used.
 */
export async function regionTargets(db: Db, keys: string[] | null, limit: number): Promise<(NearTarget & { seen: boolean })[]> {
  const only = keys && keys.length ? `AND m.scientific_name IN (SELECT scientific_name FROM region_species WHERE region_key IN (${keys.map(() => "?").join(",")}))` : "";
  const rows = await db.all<NearTarget & { tier: string | null; seen: number }>(
    `SELECT sp.scientific_name AS scientificName, sp.common_name AS commonName, sp.taxon_class AS taxonClass, NULL AS coverPhotoId,
            sp.tier AS tier, (m.state IS NOT NULL) AS seen
     FROM marks m JOIN species sp ON sp.scientific_name = m.scientific_name
     WHERE m.is_target = 1 AND COALESCE(m.state, '') <> 'collected' ${only}
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.scientific_name = m.scientific_name AND c.hidden = 0)`,
    keys && keys.length ? keys : [],
  );
  const rank = (t: string | null) => TIER_ORDER.indexOf(t as never);
  const name = (r: NearTarget) => r.commonName ?? r.scientificName;
  return rows
    .sort((a, b) => b.seen - a.seen || rank(b.tier) - rank(a.tier) || name(a).localeCompare(name(b), undefined, { sensitivity: "base" }))
    .slice(0, limit)
    .map(({ tier: _t, seen, ...r }) => ({ ...r, seen: !!seen }));
}
