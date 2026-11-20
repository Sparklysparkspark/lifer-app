// Writes a Lightroom plan into Lifer and keeps what it replaced, so the whole import can be undone
// once. The undo record is a file next to the library's app data, not a table: it only serves the
// one "Undo import" button.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { syncAlbumIndexForCaptures } from "../../albums/albumIndex.js";
import { syncCaptureXmpSidecarsLogged } from "../../uploads/xmpSidecarSync.js";
import type { JobContext } from "../../lib/job.js";
import { planEdits, plannedAlbums, type CaptureEdit, type Group } from "./plan.js";
import type { ChangeSet, LightroomFlag } from "./types.js";

const BATCH = 500;
const UNDO_FILE = path.join(APP_DATA_DIR, "lightroom-undo.json");

export interface ApplyResult {
  photos: number;
  albums: number;
}

interface Undo {
  userId: string;
  createdAt: string;
  summary: { photos: number; albums: number };
  ratings: { id: string; rating: number | null }[];
  flags: { id: string; flag: LightroomFlag | null }[];
  tags: { id: string; tags: string[] }[];
  locations: { id: string; lat: number | null; lon: number | null }[];
  albumIds: string[];
}

type Extra = { processed: number | null };
type Ctx = JobContext<ApplyResult, Extra>;

const chunks = <T>(rows: T[]) =>
  Array.from({ length: Math.ceil(rows.length / BATCH) }, (_, i) => rows.slice(i * BATCH, (i + 1) * BATCH));

async function writeRows(db: PoolClient, userId: string, set: string, shape: string, rows: object[]) {
  for (const part of chunks(rows))
    await db.query(
      `UPDATE captures c SET ${set} FROM jsonb_to_recordset($1::jsonb) AS v(${shape}) WHERE c.id = v.id AND c.user_id = $2`,
      [JSON.stringify(part), userId],
    );
}

const RATING = ["quality_rating = v.rating", "id uuid, rating int"] as const;
const FLAG = ["cull_verdict = v.flag", "id uuid, flag text"] as const;
const TAGS = ["tags = ARRAY(SELECT jsonb_array_elements_text(v.tags))", "id uuid, tags jsonb"] as const;
const PLACE = [
  "lat = v.lat, lon = v.lon, location_source = NULL, location_accuracy_m = NULL",
  "id uuid, lat float8, lon float8",
] as const;

/** Albums are made with the catalogue's name, or "<name> (Lightroom)" when one already has it. */
async function createAlbums(db: PoolClient, userId: string, cs: ChangeSet, groups: ReadonlySet<Group>) {
  const ids: string[] = [];
  const members: string[] = [];
  for (const a of plannedAlbums(cs, groups)) {
    const taken = await db.query(`SELECT 1 FROM albums WHERE user_id = $1 AND lower(name) = lower($2)`, [
      userId,
      a.name,
    ]);
    const res = await db.query<{ id: string }>(
      `INSERT INTO albums (user_id, name, rules) VALUES ($1, $2, $3) RETURNING id`,
      [
        userId,
        (taken.rowCount ? `${a.name.slice(0, 480)} (Lightroom)` : a.name).slice(0, 500),
        a.rules ? JSON.stringify(a.rules) : null,
      ],
    );
    ids.push(res.rows[0].id);
    if (!a.rules && a.captureIds.length > 0) {
      await db.query(
        `INSERT INTO album_captures (album_id, capture_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [res.rows[0].id, a.captureIds],
      );
      members.push(...a.captureIds);
    }
  }
  return { ids, members };
}

export async function applyChangeSet(
  ctx: Ctx,
  userId: string,
  cs: ChangeSet,
  groups: ReadonlySet<Group>,
  lightroomWins: boolean,
): Promise<ApplyResult> {
  const edits = planEdits(cs, groups, lightroomWins);
  const before = new Map(
    cs.photos.flatMap((p) => (p.captureId && p.current ? [[p.captureId, p.current] as const] : [])),
  );
  const undo: Undo = {
    userId,
    createdAt: new Date().toISOString(),
    summary: { photos: edits.length, albums: 0 },
    ratings: [],
    flags: [],
    tags: [],
    locations: [],
    albumIds: [],
  };
  const pick = <K extends keyof CaptureEdit>(key: K) => edits.filter((e) => e[key] !== undefined);

  ctx.update({ phase: "applying", processed: 0, total: edits.length });
  const db = await pool.connect();
  let albumMembers: string[];
  try {
    await db.query("BEGIN");
    const ratings = pick("rating");
    await writeRows(
      db,
      userId,
      ...RATING,
      ratings.map((e) => ({ id: e.id, rating: e.rating })),
    );
    undo.ratings = ratings.map((e) => ({ id: e.id, rating: before.get(e.id)!.rating }));
    ctx.update({ processed: Math.round(edits.length * 0.25) });

    const flags = pick("flag");
    await writeRows(
      db,
      userId,
      ...FLAG,
      flags.map((e) => ({ id: e.id, flag: e.flag })),
    );
    undo.flags = flags.map((e) => ({ id: e.id, flag: before.get(e.id)!.flag }));

    const tags = pick("tags");
    await writeRows(
      db,
      userId,
      ...TAGS,
      tags.map((e) => ({ id: e.id, tags: e.tags })),
    );
    undo.tags = tags.map((e) => ({ id: e.id, tags: before.get(e.id)!.tags }));
    ctx.update({ processed: Math.round(edits.length * 0.5) });

    const places = pick("lat");
    await writeRows(
      db,
      userId,
      ...PLACE,
      places.map((e) => ({ id: e.id, lat: e.lat, lon: e.lon })),
    );
    undo.locations = places.map((e) => ({ id: e.id, lat: before.get(e.id)!.lat, lon: before.get(e.id)!.lon }));

    const albums = await createAlbums(db, userId, cs, groups);
    undo.albumIds = albums.ids;
    undo.summary.albums = albums.ids.length;
    albumMembers = albums.members;
    if (ratings.length > 0) await recomputeBestQuality(db, userId);
    ctx.throwIfCancelled();
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  await mkdir(path.dirname(UNDO_FILE), { recursive: true });
  await writeFile(UNDO_FILE, JSON.stringify(undo));
  ctx.update({ processed: edits.length });
  syncFiles(
    userId,
    [...new Set([...undo.ratings, ...undo.tags, ...undo.flags].map((r) => r.id))],
    undo.locations.map((l) => l.id),
  );
  void syncAlbumIndexForCaptures([...new Set(albumMembers)]).catch(() => {});
  return { photos: edits.length, albums: undo.albumIds.length };
}

async function recomputeBestQuality(db: PoolClient, userId: string) {
  await db.query(
    `UPDATE user_species us SET best_quality = (SELECT MAX(quality_rating) FROM captures WHERE user_id = us.user_id AND species_id = us.species_id)
     WHERE us.user_id = $1`,
    [userId],
  );
}

/** Metadata files follow in the background; a few at a time because exiftool is slow. */
function syncFiles(userId: string, ids: string[], placeIds: string[]) {
  const limit = createLimiter(4);
  const places = new Set(placeIds);
  for (const id of new Set([...ids, ...placeIds]))
    void limit(() => syncCaptureXmpSidecarsLogged(userId, id, { replaceGps: places.has(id) }));
}

async function readUndo(userId: string): Promise<Undo | null> {
  try {
    const undo = JSON.parse(await readFile(UNDO_FILE, "utf8")) as Undo;
    return undo.userId === userId ? undo : null;
  } catch {
    return null;
  }
}

/** What "Undo import" would undo, or null when nothing can be. */
export async function undoSummary(
  userId: string,
): Promise<{ createdAt: string; photos: number; albums: number } | null> {
  const undo = await readUndo(userId);
  return undo && { createdAt: undo.createdAt, ...undo.summary };
}

export async function undoImport(userId: string): Promise<boolean> {
  const undo = await readUndo(userId);
  if (!undo) return false;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await writeRows(db, userId, ...RATING, undo.ratings);
    await writeRows(db, userId, ...FLAG, undo.flags);
    await writeRows(db, userId, ...TAGS, undo.tags);
    await writeRows(db, userId, ...PLACE, undo.locations);
    await db.query(`DELETE FROM albums WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, undo.albumIds]);
    if (undo.ratings.length > 0) await recomputeBestQuality(db, userId);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  syncFiles(
    userId,
    [...undo.ratings, ...undo.tags, ...undo.flags].map((r) => r.id),
    undo.locations.map((l) => l.id),
  );
  await rm(UNDO_FILE, { force: true });
  return true;
}
