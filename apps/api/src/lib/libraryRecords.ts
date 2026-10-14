// Trips and album details, recorded inside the library so a fresh install pointed at it gets them
// back (collected/seen state has its own record in collectionState.ts, album membership in
// albums/albumIndex.ts):
// - trips in .lifer/trip.json in the folder their photos are filed in (destination folder, else
//   source folder), by id with their owner's email: name, description, cover, and photos as paths
//   relative to that folder, so the trip still finds them after the drive or folder moves;
// - album details in <library>/.lifer/album-details.json, per user by email: description, cover
//   and albums that have no photos yet.
// Written a couple of seconds after a change; read back after a library reimport (library/routes.ts)
// for trips and albums this install doesn't have.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@lifer/core/db.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { isWithin } from "@lifer/core/lib/pathContainment.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { log } from "@lifer/core/lib/log.js";
import { writeFileAtomicSync } from "./atomicWrite.js";

interface Crop {
  x: number;
  y: number;
  size: number;
}
interface PhotoRef {
  file: string;
  crop: Crop | null;
}
export interface TripRecord {
  /** The owner's email, so on a shared server only they get it back. */
  owner: string;
  name: string;
  description: string | null;
  /** Relative to the record's folder when inside it or the library, else absolute; "." is the folder itself. */
  sourceFolder: string;
  destinationFolder: string | null;
  coverLayout: string | null;
  cover: PhotoRef | null;
  quad: Array<PhotoRef | null>;
  /** The trip's photos, relative to the record's folder when inside it, else absolute. */
  photos: string[];
  createdAt: string;
}
/** A folder's trips by id; several trips can share a destination folder. */
interface TripRecordFile {
  version: 1;
  trips: Record<string, TripRecord>;
}
interface AlbumDetails {
  description: string | null;
  coverLayout: string | null;
  cover: PhotoRef | null;
  quad: Array<PhotoRef | null>;
  createdAt: string;
}
interface AlbumDetailsFile {
  version: 1;
  updatedAt: string;
  users: Record<string, Record<string, AlbumDetails>>;
}

const TRIP_RECORD = "trip.json";
const tripRecordPath = (folder: string) => path.join(folder, ".lifer", TRIP_RECORD);
export const albumDetailsPath = () => path.join(ORIGINALS_DIR, ".lifer", "album-details.json");

/** A path relative to `base` when it's inside it, or when both are in the library (so a trip whose
 *  source is the folder above its photos still finds it after the whole library moves); else
 *  absolute. resolveFrom turns it back. */
const portable = (base: string, p: string) =>
  isWithin(base, p) || (isWithin(ORIGINALS_DIR, base) && isWithin(ORIGINALS_DIR, p))
    ? path.relative(base, p) || "."
    : p;
const resolveFrom = (base: string, p: string) => (path.isAbsolute(p) ? p : path.join(base, p));

function readTripRecords(base: string): TripRecordFile | null {
  try {
    const parsed = JSON.parse(readFileSync(tripRecordPath(base), "utf8")) as TripRecordFile;
    return parsed?.version === 1 && parsed.trips ? parsed : null;
  } catch {
    return null;
  }
}

const crop = (x: unknown, y: unknown, size: unknown): Crop | null =>
  x == null || y == null || size == null ? null : { x: Number(x), y: Number(y), size: Number(size) };

// A capture's file: its path-based original, the JPEG before a RAW.
const CAPTURE_FILE_SQL = `(SELECT o.ref FROM originals o WHERE o.capture_id = %s AND o.ref_type = 'path'
  ORDER BY (o.kind = 'raw'), o.id LIMIT 1)`;
const captureFile = (column: string) => CAPTURE_FILE_SQL.replace("%s", column);

/** Each photo id's file, for covers and quad slots. */
async function photoFiles(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const res = await pool.query<{ id: string; file: string | null }>(
    `SELECT p.id, ${captureFile("p.capture_id")} AS file FROM photos p WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(res.rows.filter((r) => r.file).map((r) => [r.id, r.file!]));
}

function quadRefs(
  base: string,
  ids: (string | null)[] | null,
  crops: unknown[] | null,
  files: Map<string, string>,
): Array<PhotoRef | null> {
  if (!ids) return [];
  return [0, 1, 2, 3].map((i) => {
    const file = ids[i] ? files.get(ids[i]!) : undefined;
    const c = crops?.[i] as Crop | null | undefined;
    return file ? { file: portable(base, file), crop: c ?? null } : null;
  });
}

/** Writes every trip's record for this user, leaving other users' trips in the same files alone. A
 *  trip whose folder isn't there (an unplugged drive) keeps its last record. */
export async function saveTripRecords(userId: string): Promise<void> {
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return;
  const byBase = new Map<string, Map<string, TripRecord>>();
  const trips = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    source_folder: string;
    destination_folder: string | null;
    cover_layout: string | null;
    cover_file: string | null;
    cover_crop_x: string | null;
    cover_crop_y: string | null;
    cover_crop_size: string | null;
    quad_photo_ids: (string | null)[] | null;
    quad_crops: unknown[] | null;
    created_at: Date;
  }>(
    `SELECT t.id, t.name, t.description, t.source_folder, t.destination_folder, t.cover_layout,
            ${captureFile("t.cover_capture_id")} AS cover_file, t.cover_crop_x, t.cover_crop_y, t.cover_crop_size,
            t.quad_photo_ids, t.quad_crops, t.created_at
       FROM trips t WHERE t.user_id = $1`,
    [userId],
  );
  for (const t of trips.rows) {
    const base = t.destination_folder ?? t.source_folder;
    if (!existsSync(base)) continue;
    const photos = await pool.query<{ file: string }>(
      `SELECT ${captureFile("c.id")} AS file FROM captures c WHERE c.trip_id = $1 ORDER BY c.taken_at NULLS LAST, c.id`,
      [t.id],
    );
    const quadFiles = await photoFiles((t.quad_photo_ids ?? []).filter((x): x is string => !!x));
    const record: TripRecord = {
      owner: user.email,
      name: t.name,
      description: t.description,
      sourceFolder: portable(base, t.source_folder),
      destinationFolder: t.destination_folder ? portable(base, t.destination_folder) : null,
      coverLayout: t.cover_layout,
      cover: t.cover_file
        ? { file: portable(base, t.cover_file), crop: crop(t.cover_crop_x, t.cover_crop_y, t.cover_crop_size) }
        : null,
      quad: quadRefs(base, t.quad_photo_ids, t.quad_crops, quadFiles),
      photos: photos.rows.filter((r) => r.file).map((r) => portable(base, r.file)),
      createdAt: t.created_at.toISOString(),
    };
    if (!byBase.has(base)) byBase.set(base, new Map());
    byBase.get(base)!.set(t.id, record);
  }
  for (const [base, mine] of byBase) {
    try {
      await ensureDir(path.dirname(tripRecordPath(base)));
      // No await between read and write, so another user's save to the same folder isn't lost.
      const file = readTripRecords(base) ?? { version: 1 as const, trips: {} };
      for (const [id, r] of Object.entries(file.trips))
        if (r.owner === user.email && !mine.has(id)) delete file.trips[id];
      for (const [id, r] of mine) file.trips[id] = r;
      writeFileAtomicSync(tripRecordPath(base), JSON.stringify(file, null, 2));
    } catch (err) {
      log.warn(`[library-records] couldn't save trips in ${base}: ${(err as Error).message}`);
    }
  }
}

/** Removes a deleted trip's record, so a reimport doesn't bring it back. */
export function removeTripRecord(tripId: string, sourceFolder: string, destinationFolder: string | null): void {
  const base = destinationFolder ?? sourceFolder;
  const file = readTripRecords(base);
  if (!file?.trips[tripId]) return;
  delete file.trips[tripId];
  if (Object.keys(file.trips).length === 0) rmSync(tripRecordPath(base), { force: true });
  else writeFileAtomicSync(tripRecordPath(base), JSON.stringify(file, null, 2));
}

function readAlbumDetails(): AlbumDetailsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(albumDetailsPath(), "utf8")) as AlbumDetailsFile;
    return parsed?.version === 1 && parsed.users ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes this user's album details into the library's record. */
export async function saveAlbumDetails(userId: string): Promise<void> {
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return;
  const albums = await pool.query<{
    name: string;
    description: string | null;
    cover_layout: string | null;
    cover_photo_id: string | null;
    cover_crop_x: string | null;
    cover_crop_y: string | null;
    cover_crop_size: string | null;
    quad_photo_ids: (string | null)[] | null;
    quad_crops: unknown[] | null;
    created_at: Date;
  }>(
    `SELECT name, description, cover_layout, cover_photo_id, cover_crop_x, cover_crop_y, cover_crop_size,
            quad_photo_ids, quad_crops, created_at
       FROM albums WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  if (albums.rows.length === 0 && !readAlbumDetails()?.users[user.email]) return;
  const ids = albums.rows
    .flatMap((a) => [a.cover_photo_id, ...(a.quad_photo_ids ?? [])])
    .filter((x): x is string => !!x);
  const files = await photoFiles(ids);
  const details: Record<string, AlbumDetails> = {};
  for (const a of albums.rows) {
    const coverFile = a.cover_photo_id ? files.get(a.cover_photo_id) : undefined;
    details[a.name] = {
      description: a.description,
      coverLayout: a.cover_layout,
      cover: coverFile
        ? {
            file: portable(ORIGINALS_DIR, coverFile),
            crop: crop(a.cover_crop_x, a.cover_crop_y, a.cover_crop_size),
          }
        : null,
      quad: quadRefs(ORIGINALS_DIR, a.quad_photo_ids, a.quad_crops, files),
      createdAt: a.created_at.toISOString(),
    };
  }
  await ensureDir(path.dirname(albumDetailsPath()));
  // Read just before the write with no await between, so another user's save isn't lost.
  const file = readAlbumDetails() ?? { version: 1 as const, updatedAt: "", users: {} };
  file.users[user.email] = details;
  file.updatedAt = new Date().toISOString();
  writeFileAtomicSync(albumDetailsPath(), JSON.stringify(file, null, 2));
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
function schedule(key: string, save: () => Promise<void>): void {
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      save().catch((err) => log.warn(`[library-records] couldn't save: ${(err as Error).message}`));
    }, 2000),
  );
}
/** Saves a couple of seconds after the last change, so a bulk change writes once. */
export const scheduleTripRecordsSave = (userId: string) => schedule(`trips:${userId}`, () => saveTripRecords(userId));
export const scheduleAlbumDetailsSave = (userId: string) =>
  schedule(`albums:${userId}`, () => saveAlbumDetails(userId));

// Requests that can change a trip (or which photos are in one) or an album. Matched after a
// successful response rather than wired into each route, like collectionState.ts.
const TRIP_ROUTES = [/^\/api\/trips(\/|$)/, /^\/api\/captures(\/|$)/, /^\/api\/uploads$/];
const ALBUM_ROUTES = [/^\/api\/albums(\/|$)/, /^\/api\/photos(\/|$)/];

export function registerLibraryRecordSaving(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    if (request.method === "GET" || reply.statusCode >= 400 || !request.user) return;
    const url = request.url.split("?")[0];
    if (TRIP_ROUTES.some((re) => re.test(url))) scheduleTripRecordsSave(request.user.id);
    if (ALBUM_ROUTES.some((re) => re.test(url))) scheduleAlbumDetailsSave(request.user.id);
  });
}

/** Every trip record under `root`. Dot folders aren't walked, except each folder's own .lifer. */
export function findTripRecords(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(tripRecordPath(dir))) found.push(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) walk(path.join(dir, e.name));
  };
  walk(root);
  return found;
}

/** Photo ids for files, through their captures' path-based originals. */
async function photoIdsByFile(userId: string, files: string[]): Promise<Map<string, string>> {
  if (files.length === 0) return new Map();
  const res = await pool.query<{ ref: string; photo_id: string }>(
    `SELECT DISTINCT ON (o.ref) o.ref, p.id AS photo_id
       FROM originals o JOIN captures c ON c.id = o.capture_id JOIN photos p ON p.capture_id = c.id
      WHERE c.user_id = $1 AND o.ref_type = 'path' AND o.ref = ANY($2)
      ORDER BY o.ref, p.created_at, p.id`,
    [userId, files],
  );
  return new Map(res.rows.map((r) => [r.ref, r.photo_id]));
}

function quadColumns(
  base: string,
  quad: Array<PhotoRef | null>,
  photoIds: Map<string, string>,
): { ids: (string | null)[]; crops: (Crop | null)[] } | null {
  if (!quad?.length) return null;
  const ids = quad.map((q) => (q ? (photoIds.get(resolveFrom(base, q.file)) ?? null) : null));
  if (ids.every((x) => !x)) return null;
  return { ids, crops: quad.map((q, i) => (ids[i] && q ? q.crop : null)) };
}

export interface LibraryRecordsRestored {
  trips: number;
  tripPhotos: number;
  albums: number;
}

/** Brings back this user's trips found under `root` that this install doesn't have, and album
 *  details for albums that have none. Run after a library reimport, once the photos are back. */
export async function restoreLibraryRecords(userId: string, root: string): Promise<LibraryRecordsRestored> {
  const restored: LibraryRecordsRestored = { trips: 0, tripPhotos: 0, albums: 0 };
  const user = (await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) return restored;

  for (const base of findTripRecords(root)) {
    for (const [id, record] of Object.entries(readTripRecords(base)?.trips ?? {})) {
      if (record?.owner !== user.email || !record.name) continue;
      // One trip at a time: a bad record is skipped without leaving a half-restored trip or
      // stopping the rest.
      try {
        const photos = await restoreTrip(userId, base, id, record);
        if (photos == null) continue;
        restored.trips++;
        restored.tripPhotos += photos;
      } catch (err) {
        log.warn(`[library-records] couldn't restore trip "${record.name}": ${(err as Error).message}`);
      }
    }
  }

  const details = readAlbumDetails()?.users[user.email];
  for (const [name, d] of Object.entries(details ?? {})) {
    const existing = await pool.query<{ id: string; description: string | null; cover_photo_id: string | null }>(
      `SELECT id, description, cover_photo_id FROM albums WHERE user_id = $1 AND name = $2 LIMIT 1`,
      [userId, name],
    );
    let album = existing.rows[0];
    if (!album) {
      // An album that had no photos: membership can't bring it back, the details can.
      album = (
        await pool.query<{ id: string; description: string | null; cover_photo_id: string | null }>(
          `INSERT INTO albums (user_id, name, created_at) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
           RETURNING id, description, cover_photo_id`,
          [userId, name, d.createdAt ?? null],
        )
      ).rows[0];
    } else if (album.description != null || album.cover_photo_id != null) {
      continue; // This install has its own details for it.
    }
    const coverFile = d.cover ? resolveFrom(ORIGINALS_DIR, d.cover.file) : null;
    const quadFiles = (d.quad ?? []).filter((q): q is PhotoRef => !!q).map((q) => resolveFrom(ORIGINALS_DIR, q.file));
    const photoIds = await photoIdsByFile(userId, [...quadFiles, ...(coverFile ? [coverFile] : [])]);
    const quad = quadColumns(ORIGINALS_DIR, d.quad, photoIds);
    await pool.query(
      `UPDATE albums SET description = $2, cover_layout = $3, cover_photo_id = $4,
                         cover_crop_x = $5, cover_crop_y = $6, cover_crop_size = $7,
                         quad_photo_ids = $8, quad_crops = $9
        WHERE id = $1`,
      [
        album.id,
        d.description,
        d.coverLayout,
        coverFile ? (photoIds.get(coverFile) ?? null) : null,
        d.cover?.crop?.x ?? null,
        d.cover?.crop?.y ?? null,
        d.cover?.crop?.size ?? null,
        quad?.ids ?? null,
        quad ? JSON.stringify(quad.crops) : null,
      ],
    );
    restored.albums++;
  }
  return restored;
}

/** Restores one trip under its recorded id; null when this install already has it (by id, or by
 *  name in the same folder). Returns how many photos joined it. */
async function restoreTrip(userId: string, base: string, id: string, record: TripRecord): Promise<number | null> {
  const source = resolveFrom(base, record.sourceFolder);
  const destination = record.destinationFolder ? resolveFrom(base, record.destinationFolder) : null;
  const files = record.photos.map((p) => resolveFrom(base, p));
  const coverFile = record.cover ? resolveFrom(base, record.cover.file) : null;
  const quadFiles = (record.quad ?? []).filter((q): q is PhotoRef => !!q).map((q) => resolveFrom(base, q.file));
  const photoIds = await photoIdsByFile(userId, [...quadFiles, ...(coverFile ? [coverFile] : [])]);
  const quad = quadColumns(base, record.quad, photoIds);
  return withTransaction(async (client) => {
    const known = await client.query(
      `SELECT 1 FROM trips WHERE id = $1
          OR (user_id = $2 AND name = $3 AND (source_folder = $4 OR destination_folder = $5))`,
      [id, userId, record.name, source, destination ?? source],
    );
    if (known.rowCount) return null;
    await client.query(
      `INSERT INTO trips (id, user_id, name, description, source_folder, destination_folder, cover_layout,
                          quad_photo_ids, quad_crops, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'single'), $8, $9, COALESCE($10::timestamptz, now()))`,
      [
        id,
        userId,
        record.name,
        record.description,
        source,
        destination,
        record.coverLayout,
        quad?.ids ?? null,
        quad ? JSON.stringify(quad.crops) : null,
        record.createdAt ?? null,
      ],
    );
    // Only photos that aren't in another trip already.
    const joined = await client.query(
      `UPDATE captures c SET trip_id = $1
        WHERE c.user_id = $2 AND c.trip_id IS NULL
          AND EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.ref_type = 'path' AND o.ref = ANY($3))`,
      [id, userId, files],
    );
    if (coverFile) {
      await client.query(
        `UPDATE trips SET cover_capture_id = (SELECT o.capture_id FROM originals o JOIN captures c ON c.id = o.capture_id
                                               WHERE c.user_id = $2 AND o.ref_type = 'path' AND o.ref = $3 LIMIT 1),
                          cover_crop_x = $4, cover_crop_y = $5, cover_crop_size = $6
          WHERE id = $1`,
        [
          id,
          userId,
          coverFile,
          record.cover?.crop?.x ?? null,
          record.cover?.crop?.y ?? null,
          record.cover?.crop?.size ?? null,
        ],
      );
    }
    return joined.rowCount ?? 0;
  });
}
