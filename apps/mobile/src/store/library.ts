import type { Db, Param } from "./db";
import { FEATURED_SQL } from "./marks";

export interface CaptureRow {
  id: string;
  photoId: string | null;
  scientificName: string;
  takenAt: string | null;
  locationLabel: string | null;
  tags: string[];
  rating: number | null;
  regionId: string | null;
  tripId: string | null;
  hidden: boolean;
  kind: string;
  width: number | null;
  height: number | null;
}

/** What the change feed sends for a capture (the fields the phone keeps). */
export interface CaptureChange {
  id: string;
  deletedAt: string | null;
  hiddenAt: string | null;
  scientificName: string;
  takenAt: string | null;
  tags: string[];
  qualityRating: number | null;
  locationLabel: string | null;
  regionId: string | null;
  tripId?: string | null;
  lat?: number | null;
  lon?: number | null;
  cameraModel?: string | null;
  focalLengthMm?: number | null;
  photo: { id: string; width: number | null; height: number | null; kind: string } | null;
}

/** Trashed captures leave the phone like purged ones; hidden ones stay but out of every list. */
export async function applyCaptureChanges(db: Db, items: CaptureChange[], purged: string[]): Promise<void> {
  for (const c of items) {
    if (c.deletedAt) {
      purged.push(c.id);
      continue;
    }
    await db.run("INSERT OR IGNORE INTO species (scientific_name) VALUES (?)", [c.scientificName]);
    await db.run(
      `INSERT INTO captures (id, photo_id, scientific_name, taken_at, location_label, tags, rating, region_id, trip_id,
         hidden, kind, width, height, lat, lon, camera_model, focal_length_mm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET photo_id = excluded.photo_id, scientific_name = excluded.scientific_name,
         taken_at = excluded.taken_at, location_label = excluded.location_label, tags = excluded.tags,
         rating = excluded.rating, region_id = excluded.region_id, trip_id = excluded.trip_id,
         hidden = excluded.hidden, kind = excluded.kind, width = excluded.width, height = excluded.height,
         lat = excluded.lat, lon = excluded.lon, camera_model = excluded.camera_model,
         focal_length_mm = excluded.focal_length_mm`,
      [
        c.id,
        c.photo?.id ?? null,
        c.scientificName,
        c.takenAt,
        c.locationLabel,
        JSON.stringify(c.tags ?? []),
        c.qualityRating,
        c.regionId,
        c.tripId ?? null,
        c.hiddenAt ? 1 : 0,
        c.photo?.kind ?? "image",
        c.photo?.width ?? null,
        c.photo?.height ?? null,
        c.lat ?? null,
        c.lon ?? null,
        c.cameraModel ?? null,
        c.focalLengthMm ?? null,
      ],
    );
  }
  for (const id of purged) {
    await db.run("DELETE FROM captures WHERE id = ?", [id]);
    for (const t of ["capture_vectors", "capture_frames", "capture_backgrounds"])
      await db.run(`DELETE FROM ${t} WHERE capture_id = ?`, [id]);
    await db.run("DELETE FROM album_captures WHERE capture_id = ?", [id]);
  }
}

interface RawCapture {
  id: string;
  photo_id: string | null;
  scientific_name: string;
  taken_at: string | null;
  location_label: string | null;
  tags: string;
  rating: number | null;
  region_id: string | null;
  trip_id: string | null;
  hidden: number;
  kind: string;
  width: number | null;
  height: number | null;
}

const captureFrom = (r: RawCapture): CaptureRow => ({
  id: r.id,
  photoId: r.photo_id,
  scientificName: r.scientific_name,
  takenAt: r.taken_at,
  locationLabel: r.location_label,
  tags: JSON.parse(r.tags || "[]") as string[],
  rating: r.rating,
  regionId: r.region_id,
  tripId: r.trip_id,
  hidden: !!r.hidden,
  kind: r.kind,
  width: r.width,
  height: r.height,
});

const SHOWN = "photo_id IS NOT NULL AND hidden = 0 AND kind = 'image'";

export interface GridPhoto {
  photoId: string;
  takenAt: string | null;
}

/** The whole library, newest first, as light rows (the grid is laid out from these). */
export const libraryPhotos = (db: Db, limit = -1): Promise<GridPhoto[]> =>
  db.all<{ photoId: string; takenAt: string | null }>(
    `SELECT photo_id AS photoId, taken_at AS takenAt FROM captures WHERE ${SHOWN}
     ORDER BY taken_at IS NULL, taken_at DESC, id LIMIT ?`,
    [limit],
  );

export type PhotoSort = "best" | "newest" | "oldest";
const PHOTO_ORDER: Record<PhotoSort, string> = {
  best: "rating DESC, taken_at DESC",
  newest: "taken_at IS NULL, taken_at DESC",
  oldest: "taken_at IS NULL, taken_at ASC",
};

export const speciesPhotos = (
  db: Db,
  scientificName: string,
  sort: PhotoSort = "best",
  limit = 5000,
): Promise<GridPhoto[]> =>
  db.all<{ photoId: string; takenAt: string | null }>(
    `SELECT photo_id AS photoId, taken_at AS takenAt FROM captures WHERE ${SHOWN} AND scientific_name = ?
     ORDER BY ${PHOTO_ORDER[sort]}, id LIMIT ?`,
    [scientificName, limit],
  );

export const tripPhotos = (db: Db, tripId: string): Promise<GridPhoto[]> =>
  db.all<{ photoId: string; takenAt: string | null }>(
    `SELECT photo_id AS photoId, taken_at AS takenAt FROM captures WHERE ${SHOWN} AND trip_id = ?
     ORDER BY taken_at DESC LIMIT 2000`,
    [tripId],
  );

export const photoCount = async (db: Db): Promise<number> =>
  Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM captures WHERE ${SHOWN}`))?.n ?? 0);

export async function captureByPhoto(db: Db, photoId: string): Promise<CaptureRow | null> {
  const r = await db.get<RawCapture>("SELECT * FROM captures WHERE photo_id = ? LIMIT 1", [photoId]);
  return r ? captureFrom(r) : null;
}

/** Newest photos, for Home. */
export const recentPhotos = (db: Db, n: number): Promise<GridPhoto[]> => libraryPhotos(db, n);

/** Photos of these species by name, then of captures whose tags or place mention the text. */
export async function photosForSpecies(db: Db, names: string[], text: string): Promise<GridPhoto[]> {
  const params: Param[] = [];
  const parts: string[] = [];
  if (names.length) {
    for (let i = 0; i < names.length; i += 500) {
      const chunk = names.slice(i, i + 500);
      parts.push(`scientific_name IN (${chunk.map(() => "?").join(",")})`);
      params.push(...chunk);
    }
  }
  const like = `%${text.replace(/[%_\\]/g, "\\$&")}%`;
  parts.push(`tags LIKE ? ESCAPE '\\'`, `location_label LIKE ? ESCAPE '\\'`);
  params.push(like, like);
  return db.all<GridPhoto>(
    `SELECT photo_id AS photoId, taken_at AS takenAt FROM captures WHERE ${SHOWN} AND (${parts.join(" OR ")})
     ORDER BY taken_at DESC LIMIT 2000`,
    params,
  );
}

export interface AlbumChange {
  id: string;
  name: string;
  coverPhotoId: string | null;
  coverCropX?: number | null;
  coverCropY?: number | null;
  coverCropSize?: number | null;
}
export interface TripChange {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  regionId: string | null;
  coverCaptureId: string | null;
  coverCropX?: number | null;
  coverCropY?: number | null;
  coverCropSize?: number | null;
  activeOverride: boolean | null;
}
export interface SpotChange {
  id: string;
  name: string;
  lat: number;
  lon: number;
  regionId: string | null;
  geoprivacy: string;
}

export async function applyAlbums(db: Db, items: AlbumChange[], purged: string[]): Promise<void> {
  for (const a of items)
    await db.run(
      `INSERT INTO albums (id, name, cover_photo_id, cover_crop_x, cover_crop_y, cover_crop_size) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, cover_photo_id = excluded.cover_photo_id,
         cover_crop_x = excluded.cover_crop_x, cover_crop_y = excluded.cover_crop_y, cover_crop_size = excluded.cover_crop_size`,
      [a.id, a.name, a.coverPhotoId, a.coverCropX ?? null, a.coverCropY ?? null, a.coverCropSize ?? null],
    );
  for (const id of purged) {
    await db.run("DELETE FROM albums WHERE id = ?", [id]);
    await db.run("DELETE FROM album_captures WHERE album_id = ?", [id]);
  }
}

export async function applyTrips(db: Db, items: TripChange[], purged: string[]): Promise<void> {
  for (const t of items)
    await db.run(
      `INSERT INTO trips (id, name, description, start_date, end_date, region_id, cover_capture_id, active_override, local,
         cover_crop_x, cover_crop_y, cover_crop_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
         start_date = excluded.start_date, end_date = excluded.end_date, region_id = excluded.region_id,
         cover_capture_id = excluded.cover_capture_id, active_override = excluded.active_override,
         cover_crop_x = excluded.cover_crop_x, cover_crop_y = excluded.cover_crop_y, cover_crop_size = excluded.cover_crop_size`,
      [
        t.id,
        t.name,
        t.description,
        t.startDate,
        t.endDate,
        t.regionId,
        t.coverCaptureId,
        t.activeOverride == null ? null : t.activeOverride ? 1 : 0,
        t.coverCropX ?? null,
        t.coverCropY ?? null,
        t.coverCropSize ?? null,
      ],
    );
  for (const id of purged) await db.run("DELETE FROM trips WHERE id = ? AND local = 0", [id]);
}

export async function applySpots(db: Db, items: SpotChange[], purged: string[]): Promise<void> {
  for (const s of items)
    await db.run(
      `INSERT INTO saved_spots (id, name, lat, lon, region_id, geoprivacy) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon,
         region_id = excluded.region_id, geoprivacy = excluded.geoprivacy`,
      [s.id, s.name, s.lat, s.lon, s.regionId, s.geoprivacy],
    );
  for (const id of purged) await db.run("DELETE FROM saved_spots WHERE id = ?", [id]);
}

/** Album membership: refs are "albumId:captureId". */
export async function applyMembers(
  db: Db,
  items: { albumId: string; captureId: string }[],
  purged: string[],
): Promise<void> {
  for (const m of items)
    await db.run("INSERT OR IGNORE INTO album_captures (album_id, capture_id) VALUES (?, ?)", [m.albumId, m.captureId]);
  for (const ref of purged) {
    const [albumId, captureId] = ref.split(":");
    if (albumId && captureId)
      await db.run("DELETE FROM album_captures WHERE album_id = ? AND capture_id = ?", [albumId, captureId]);
  }
}

/** The Featured photos (species covers) still shown, best first. */
export const featuredPhotoIds = async (db: Db): Promise<string[]> =>
  (
    await db.all<{ photo_id: string }>(
      `SELECT DISTINCT c.photo_id FROM captures c
       WHERE c.photo_id IN (${FEATURED_SQL}) AND c.hidden = 0
       ORDER BY c.rating DESC, c.taken_at DESC`,
    )
  ).map((r) => r.photo_id);

export interface TripRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  regionId: string | null;
  local: boolean;
  photos: number;
  species: number;
  active: boolean;
}

interface RawTrip {
  id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  region_id: string | null;
  active_override: number | null;
  local: number;
  photos: number;
  species: number;
}

/** A trip is active when forced on, or when today falls within its dates and it isn't forced off. */
export function tripActive(
  t: { startDate: string | null; endDate: string | null; override: number | null },
  today: string,
): boolean {
  if (t.override != null) return !!t.override;
  return !!t.startDate && t.startDate <= today && (!t.endDate || t.endDate >= today);
}

export async function listTrips(db: Db, today: string): Promise<TripRow[]> {
  const rows = await db.all<RawTrip>(
    `SELECT t.*, (SELECT count(*) FROM captures c WHERE c.trip_id = t.id AND c.photo_id IS NOT NULL) AS photos,
       (SELECT count(DISTINCT c.scientific_name) FROM captures c WHERE c.trip_id = t.id) AS species
     FROM trips t ORDER BY COALESCE(t.start_date, '') DESC, t.name COLLATE NOCASE`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    startDate: r.start_date,
    endDate: r.end_date,
    regionId: r.region_id,
    local: !!r.local,
    photos: r.photos,
    species: r.species,
    active: tripActive({ startDate: r.start_date, endDate: r.end_date, override: r.active_override }, today),
  }));
}

export async function startLocalTrip(db: Db, id: string, name: string, regionId: string | null, today: string) {
  await db.run(
    "INSERT INTO trips (id, name, start_date, region_id, active_override, local) VALUES (?, ?, ?, ?, 1, 1)",
    [id, name, today, regionId],
  );
}

export const endLocalTrip = (db: Db, id: string, today: string) =>
  db.run("UPDATE trips SET end_date = ?, active_override = 0 WHERE id = ? AND local = 1", [today, id]);

export const savedSpots = (db: Db): Promise<SpotChange[]> =>
  db.all<SpotChange>(
    "SELECT id, name, lat, lon, region_id AS regionId, geoprivacy FROM saved_spots ORDER BY name COLLATE NOCASE",
  );
