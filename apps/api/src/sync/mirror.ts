// The desktop app's copy of the linked server's collection: every capture's metadata plus a
// small derivative, never the original, so the library on this computer shows the real
// collection when the server can't be reached. Mirrored rows keep the server's ids and carry
// origin = 'mirror' (migration 149); a capture the server trashed or purged is removed here.
// Rows that were imported here (origin 'local') and also exist on the server only take the
// server's metadata, never its files, and only while they have no edit waiting to be pushed:
// the push settles those (pushServer.ts). A server trash or purge trashes them here. Species
// map by scientific name; a species this catalog lacks is skipped and counted.
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { pool, withTransaction } from "@lifer/core/db.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { log } from "@lifer/core/lib/log.js";
import { getOrCreateLocalUser } from "../auth/session.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { createJob, type JobContext } from "../lib/job.js";
import { derivativeFiles, removeFiles } from "../uploads/common.js";
import { parseRemoteJson } from "../offlinePacks/schemas.js";
import {
  asSyncApply,
  CAPTURE_META,
  ChangesPageSchema,
  deleteUserSpecies,
  FIRST_CURSOR,
  upsertUserSpecies,
  UserSpeciesListSchema,
  type CaptureChange,
  type ChangeCursor,
  type UserSpeciesRow,
} from "./changes.js";
import { forgetLibraryCursors, forgetLibraryPushes, pullLibraryMembers, pullLibraryRows } from "./libraryMirror.js";
import { assertStillLinked, linkedServer, serverFetch, type LinkedServer } from "./serverLink.js";

type Db = Pick<Pool | PoolClient, "query">;

const PAGE = 200;
const CURSOR_KEY = "mirror_cursor";
// The server this install last synced with, so a link to another one starts over.
const INSTANCE_KEY = "sync_instance";
const FETCH_CONCURRENCY = 6;
/** Which copy of each photo to keep here: the 400 px thumbnail, or also the 1,024 px grid copy. */
export const DERIVATIVE_KEY = "mirror_derivative";
export type MirrorDerivative = "thumb" | "medium";

interface StoredCursor extends ChangeCursor {
  instanceId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MirrorResult {
  applied: number;
  removed: number;
  /** Captures imported here with an edit not pushed yet: left as they are for the push. */
  kept: number;
  skippedSpecies: number;
  userSpecies: number;
  /** Albums, trips and membership taken from the server, and ones it deleted. */
  library: number;
}

/** Fetches one derivative of a photo from the server; null when it has none. */
export type FetchDerivative = (photoId: string, kind: MirrorDerivative) => Promise<Buffer | null>;

/** The files saved for each photo id, by fetchDerivatives. */
export type SavedDerivatives = Map<string, { thumb: string | null; medium: string | null }>;

const dirFor = (kind: MirrorDerivative) => path.join(APP_DATA_DIR, kind);
const fileFor = (photoId: string, kind: MirrorDerivative) => path.join(dirFor(kind), `${photoId}.webp`);

async function saveDerivative(
  photoId: string,
  kind: MirrorDerivative,
  fetchFile: FetchDerivative,
): Promise<string | null> {
  // The id becomes a file name.
  if (!UUID.test(photoId)) throw new Error(`The server sent an invalid photo id: ${photoId}`);
  const dest = fileFor(photoId, kind);
  if (
    await access(dest).then(
      () => true,
      () => false,
    )
  )
    return dest;
  const bytes = await fetchFile(photoId, kind);
  if (!bytes) return null;
  await mkdir(dirFor(kind), { recursive: true });
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
  return dest;
}

async function speciesIdByName(db: Db, names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const res = await db.query<{ id: string; scientific_name: string }>(
    `SELECT DISTINCT ON (scientific_name) id, scientific_name FROM species WHERE scientific_name = ANY($1) ORDER BY scientific_name, id`,
    [names],
  );
  return new Map(res.rows.map((r) => [r.scientific_name, r.id]));
}

/** Downloads the derivatives a page of changes needs, before any transaction opens. Captures
 *  imported here keep their own files, and species this catalog lacks are skipped. */
export async function fetchDerivatives(
  db: Db,
  userId: string,
  items: CaptureChange[],
  fetchFile: FetchDerivative,
  derivative: MirrorDerivative,
): Promise<SavedDerivatives> {
  const saved: SavedDerivatives = new Map();
  const species = await speciesIdByName(db, [
    ...new Set(items.filter((i) => !i.deletedAt).map((i) => i.scientificName)),
  ]);
  const wanted = items.filter((i) => !i.deletedAt && i.photo && species.has(i.scientificName));
  if (wanted.length === 0) return saved;
  const localRows = await db.query<{ id: string; remote_id: string | null }>(
    `SELECT id, remote_id FROM captures_all WHERE user_id = $1 AND origin = 'local' AND (id = ANY($2::uuid[]) OR remote_id = ANY($2::uuid[]))`,
    [userId, wanted.map((i) => i.id)],
  );
  const local = new Set(localRows.rows.flatMap((r) => [r.id, r.remote_id]));
  await mapWithConcurrency(
    wanted.filter((i) => !local.has(i.id)),
    FETCH_CONCURRENCY,
    async (item) => {
      const photoId = item.photo!.id;
      const thumb = await saveDerivative(photoId, "thumb", fetchFile);
      const medium = derivative === "medium" ? await saveDerivative(photoId, "medium", fetchFile) : null;
      saved.set(photoId, { thumb, medium });
    },
  );
  return saved;
}

// Not overwritten by the server's copy: a capture with an edit here not pushed yet. A mirrored one
// is settled when taken, so only a later edit makes it due.
const UNPUSHED = `((captures_all.origin = 'local' AND captures_all.pushed_at IS NULL) OR captures_all.updated_at > captures_all.pushed_at)`;

/** Applies one page of the server's changes to this install, with the files fetchDerivatives
 *  saved. firstMissing is the index of the first capture still lacking a file it needs. Runs
 *  inside the caller's transaction. */
export async function applyChanges(
  db: Db,
  userId: string,
  items: CaptureChange[],
  files: SavedDerivatives,
  derivative: MirrorDerivative,
): Promise<Omit<MirrorResult, "userSpecies" | "library"> & { firstMissing: number | null }> {
  await asSyncApply(db);
  let firstMissing: number | null = null;
  let applied = 0;
  let kept = 0;
  let skippedSpecies = 0;
  const removed = await dropCaptures(
    db,
    userId,
    items.flatMap((i) => (i.deletedAt ? [{ id: i.id, deletedAt: i.deletedAt, base: i.updatedAt }] : [])),
  );
  const species = await speciesIdByName(db, [
    ...new Set(items.filter((i) => !i.deletedAt).map((i) => i.scientificName)),
  ]);
  // $1-$5: id, user, species, fingerprint, region; then CAPTURE_META's fields; then the server's
  // updated_at, the trip id and whether the server sent one.
  const metaColumns = CAPTURE_META.map(([column]) => column);
  const at = metaColumns.length + 6;
  const values = metaColumns.map((_, i) => `$${i + 6}`).join(", ");

  for (const [index, item] of items.entries()) {
    if (item.deletedAt) continue;
    const speciesId = species.get(item.scientificName);
    if (!speciesId) {
      skippedSpecies++;
      continue;
    }
    // A capture imported here and pushed earlier may live under its own id with remote_id set.
    const existing = await db.query<{ id: string; origin: string }>(
      `SELECT id, origin FROM captures_all WHERE user_id = $2 AND (id = $1 OR remote_id = $1) ORDER BY (id = $1) DESC LIMIT 1`,
      [item.id, userId],
    );
    const local = existing.rows[0]?.origin === "local";
    const localId = existing.rows[0]?.id ?? item.id;
    const regionId = item.regionId
      ? (await db.query(`SELECT 1 FROM regions WHERE id = $1`, [item.regionId])).rowCount
        ? item.regionId
        : null
      : null;
    const written = await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, region_id, ${metaColumns.join(", ")},
         remote_updated_at, origin, pushed_at, trip_id)
       VALUES ($1, $2, $3, $4, $5, ${values}, $${at}, 'mirror', now(), (SELECT id FROM trips WHERE id = $${at + 1}::uuid))
       ON CONFLICT (id) DO UPDATE SET species_id = EXCLUDED.species_id, region_id = EXCLUDED.region_id,
         ${metaColumns.map((c) => `${c} = EXCLUDED.${c}`).join(", ")},
         trip_id = CASE WHEN $${at + 2}::boolean THEN EXCLUDED.trip_id ELSE captures_all.trip_id END,
         -- Live on the server, so back from the trash here too.
         deleted_at = NULL, remote_updated_at = EXCLUDED.remote_updated_at,
         -- The server's copy is what the server has: nothing to push back.
         pushed_at = now()
       WHERE NOT (${UNPUSHED})`,
      [
        localId,
        userId,
        speciesId,
        item.fingerprint,
        regionId,
        ...CAPTURE_META.map(([, field]) => item[field]),
        item.updatedAt,
        item.tripId ?? null,
        item.tripId !== undefined,
      ],
    );
    if (written.rowCount === 0) {
      kept++;
      continue;
    }
    // A locally imported capture has its own derivatives; only mirrored ones take the server's.
    if (!local && item.photo) {
      const { thumb = null, medium = null } = files.get(item.photo.id) ?? {};
      if (!thumb || (derivative === "medium" && !medium)) firstMissing ??= index;
      if (thumb) {
        await db.query(
          `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height, kind, duration_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET display_path = EXCLUDED.display_path, thumb_path = EXCLUDED.thumb_path,
             width = EXCLUDED.width, height = EXCLUDED.height`,
          [
            item.photo.id,
            localId,
            medium ?? thumb,
            thumb,
            item.photo.width,
            item.photo.height,
            item.photo.kind,
            item.photo.durationSeconds,
          ],
        );
        // A new photo needs its animals counted again, which the background catch-up does.
        await db.query(
          `UPDATE captures_all
              SET subject_count = CASE WHEN current_photo_id IS DISTINCT FROM $1 THEN NULL ELSE subject_count END,
                  current_photo_id = $1
            WHERE id = $2`,
          [item.photo.id, localId],
        );
      }
    }
    applied++;
  }
  return { applied, removed, kept, skippedSpecies, firstMissing };
}

/** Captures the server trashed or purged: mirrored ones go, file and all; ones imported here go
 *  to the trash here, unless they have an edit waiting to be pushed. base is the server's
 *  updated_at for a trashed one, null for a purged one. Returns how many went. */
export async function dropCaptures(
  db: Db,
  userId: string,
  gone: { id: string; deletedAt: string; base: string | null }[],
): Promise<number> {
  if (gone.length === 0) return 0;
  await asSyncApply(db);
  const ids = gone.map((g) => g.id);
  const mirrored = await removeMirrored(db, userId, `c.id = ANY($2::uuid[])`, [ids]);
  const trashed = await db.query(
    `UPDATE captures_all SET deleted_at = COALESCE(captures_all.deleted_at, g.deleted_at),
       remote_updated_at = g.base, pushed_at = now()
     FROM unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS g(id, deleted_at, base)
     WHERE captures_all.user_id = $1 AND (captures_all.id = g.id OR captures_all.remote_id = g.id)
       AND NOT (${UNPUSHED})`,
    [userId, ids, gone.map((g) => g.deletedAt), gone.map((g) => g.base)],
  );
  return mirrored + (trashed.rowCount ?? 0);
}

/** Takes the server's species marks for every species this catalog knows, and drops the ones the
 *  server no longer has. Marks changed here and not pushed yet are left for the push. */
export async function applyUserSpecies(db: Db, userId: string, rows: UserSpeciesRow[]): Promise<number> {
  await asSyncApply(db);
  await deleteUserSpecies(
    db,
    userId,
    rows.map((r) => r.scientificName),
    { keep: true, mirrored: true },
  );
  return upsertUserSpecies(db, userId, rows, { mirrored: true });
}

/** Deletes the mirrored captures matching `where` (over captures_all c, $1 = user) with their
 *  photo rows and files. Covers that pointed at those photos are cleared first (the FK has no
 *  cascade). Returns how many captures went. */
async function removeMirrored(db: Db, userId: string, where: string, params: unknown[]): Promise<number> {
  const photos = await db.query<{ id: string }>(
    `SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id
     WHERE c.user_id = $1 AND c.origin = 'mirror' AND ${where}`,
    [userId, ...params],
  );
  const photoIds = photos.rows.map((p) => p.id);
  if (photoIds.length > 0) {
    await db.query(`UPDATE user_species SET cover_photo_id = NULL WHERE cover_photo_id = ANY($1::uuid[])`, [photoIds]);
    await db.query(`UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ANY($1::uuid[])`, [photoIds]);
  }
  const gone = await db.query(`DELETE FROM captures_all c WHERE c.user_id = $1 AND c.origin = 'mirror' AND ${where}`, [
    userId,
    ...params,
  ]);
  for (const id of photoIds) removeFiles(derivativeFiles(id));
  return gone.rowCount ?? 0;
}

// Bumped by every reset, so a pull already running doesn't save its place over the reset.
let cursorResets = 0;
// Failed tries per capture this run of the app: one the server never serves stops holding the
// cursor back after a few, so every pull doesn't re-walk from it.
const missedTries = new Map<string, number>();
const MAX_MISSED_TRIES = 3;

/** Makes the next pull start from the beginning. */
export async function forgetMirrorCursor(db: Db): Promise<void> {
  cursorResets++;
  await db.query(`DELETE FROM install_settings WHERE key = $1`, [CURSOR_KEY]);
  await forgetLibraryCursors(db);
}

/** Drops every mirrored row (and its files): the link now points at another server. */
export async function clearMirror(db: Db, userId: string): Promise<void> {
  await asSyncApply(db);
  await removeMirrored(db, userId, `true`, []);
}

const PENDING_KEY = "sync_pending_instance";

/** Thrown while the link points at a server that isn't the one this install last synced with and
 *  the user hasn't said to start over (journey H, a reinstalled server). */
export class ServerChangedError extends Error {
  constructor() {
    super("This server looks new, perhaps reinstalled. Confirm in Settings to send your library to it again.");
  }
}

/** The new server's instance id while the user hasn't answered, else null. */
export const pendingServer = (db: Db) => getInstallSetting<string>(db as Pool, PENDING_KEY);

/** Starts over when the link now points at another server than the one this install last
 *  synced with: its mirror goes, and everything here is due for a push to the new one, without
 *  the old server's ids, versions or pending deletions. That is the user's call, so it only
 *  happens once confirmed; until then the sync stops and keeps what it has. */
export async function adoptServer(userId: string, instanceId: string, confirmed = false): Promise<void> {
  const ask = await withTransaction(async (client) => {
    const before = await getInstallSetting<string>(client, INSTANCE_KEY);
    if (before === instanceId) {
      await client.query(`DELETE FROM install_settings WHERE key = $1`, [PENDING_KEY]);
      return;
    }
    if (before !== null && !confirmed) return true;
    // Deletions recorded before this server was linked are of nothing it has.
    await client.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [userId]);
    if (before !== null) {
      await clearMirror(client, userId);
      await client.query(
        `UPDATE captures_all SET pushed_at = NULL, remote_id = NULL, remote_updated_at = NULL WHERE user_id = $1`,
        [userId],
      );
      await client.query(`UPDATE user_species SET pushed_at = NULL, remote_updated_at = NULL WHERE user_id = $1`, [
        userId,
      ]);
      await forgetLibraryPushes(client, userId);
      await forgetMirrorCursor(client);
    }
    await setInstallSetting(client, INSTANCE_KEY, instanceId);
    await client.query(`DELETE FROM install_settings WHERE key = $1`, [PENDING_KEY]);
  });
  // Outside the transaction, which has nothing to commit when it asks.
  if (ask) {
    await setInstallSetting(pool, PENDING_KEY, instanceId);
    throw new ServerChangedError();
  }
}

function saveCursor(position: ChangeCursor, instanceId: string): Promise<void> {
  return setInstallSetting(pool, CURSOR_KEY, { ...position, instanceId } satisfies StoredCursor);
}

export const mirrorJob = createJob<MirrorResult>("mirror-pull");

function fetcherFor(server: LinkedServer): FetchDerivative {
  return async (photoId, kind) => {
    const res = await serverFetch(server, `/photos/${photoId}/${kind}`);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  };
}

async function run(ctx: JobContext<MirrorResult>): Promise<MirrorResult> {
  const server = await linkedServer();
  if (!server) throw new Error("The linked server didn't answer");
  const userId = (await getOrCreateLocalUser()).id;
  const derivative = ((await getInstallSetting<string>(pool, DERIVATIVE_KEY)) as MirrorDerivative | null) ?? "thumb";
  await adoptServer(userId, server.instanceId);
  const cursor = await getInstallSetting<StoredCursor>(pool, CURSOR_KEY);
  let position: ChangeCursor = cursor ?? FIRST_CURSOR;
  const totals: MirrorResult = { applied: 0, removed: 0, kept: 0, skippedSpecies: 0, userSpecies: 0, library: 0 };
  const fetchFile = fetcherFor(server);
  // Once a capture misses a file, the saved cursor stays before it so a later pull retries it.
  let held = false;
  const resetsAtStart = cursorResets;
  const save = (at: ChangeCursor) =>
    cursorResets === resetsAtStart ? saveCursor(at, server.instanceId) : Promise.resolve();

  // Trips and albums first: captures carry their trip.
  ctx.update({ phase: "albums" });
  const rows = await pullLibraryRows(server, userId);
  totals.library += rows.applied + rows.removed;

  ctx.update({ phase: "captures" });
  for (;;) {
    ctx.throwIfCancelled();
    assertStillLinked(server);
    const res = await serverFetch(
      server,
      `/sync/changes?since=${encodeURIComponent(position.since)}&after=${position.after}&limit=${PAGE}`,
    );
    if (!res.ok) throw new Error(`The server's change list answered ${res.status}`);
    const page = parseRemoteJson(ChangesPageSchema, await res.json(), "server's change list");
    if (!page.last) break;
    const files = await fetchDerivatives(pool, userId, page.items, fetchFile, derivative);
    const r = await withTransaction(async (client) => {
      const purged = page.purged.map((p) => ({ ...p, base: null }));
      const removed = await dropCaptures(client, userId, purged);
      const applied = await applyChanges(client, userId, page.items, files, derivative);
      return { ...applied, removed: applied.removed + removed };
    });
    totals.applied += r.applied;
    totals.removed += r.removed;
    totals.kept += r.kept;
    totals.skippedSpecies += r.skippedSpecies;
    const missing = r.firstMissing !== null ? page.items[r.firstMissing] : undefined;
    const tries = missing ? (missedTries.get(missing.id) ?? 0) + 1 : 0;
    if (missing) missedTries.set(missing.id, tries);
    if (!held && missing && tries <= MAX_MISSED_TRIES) {
      held = true;
      const before = page.items[r.firstMissing! - 1];
      if (before) await save({ since: before.updatedAt, after: before.id });
    }
    position = page.last;
    if (!held) await save(position);
    ctx.update({ processed: totals.applied + totals.removed });
    if (!page.next) break;
  }

  ctx.update({ phase: "membership" });
  const members = await pullLibraryMembers(server, userId);
  totals.library += members.applied + members.removed;

  ctx.update({ phase: "species" });
  const us = await serverFetch(server, "/sync/user-species");
  if (us.ok) {
    const rows = parseRemoteJson(UserSpeciesListSchema, await us.json(), "server's species marks");
    totals.userSpecies = await withTransaction((client) => applyUserSpecies(client, userId, rows.items));
  }
  log.info(
    `[sync] mirror: ${totals.library} albums, trips and album photos, ${totals.applied} captures applied, ${totals.removed} removed, ${totals.kept} kept for the push (edited here), ${totals.skippedSpecies} skipped (species not in this catalog), ${totals.userSpecies} species marks`,
  );
  return totals;
}

export function startMirrorPull(): boolean {
  return mirrorJob.start(run);
}
