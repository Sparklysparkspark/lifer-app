// The desktop app's push: everything imported or changed on this computer goes to the linked
// server, so the server stays the library. Captures with origin 'local' whose updated_at is
// past their pushed_at (migration 150) are sent as metadata (POST /sync/push); the ones the
// server has never seen are uploaded first, like any import, with vectors computed here so the
// server skips its models. Species marks go the same way. The first run on a never-linked
// library is the whole library: "move my library to the server" is just this job. Deletions
// (sync_tombstones, migration 152) go too, and the server's conflict answers are taken here at
// once (pushServer.ts has the rule).
// Albums, trips and their membership go in the same job (libraryMirror.ts).
import { readFile, stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "@lifer/core/config.js";
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { log } from "@lifer/core/lib/log.js";
import { encodeVector, type ClientVectors, type PhotoVectorKind } from "@lifer/core/species/clientVectors.js";
import { contentHash } from "@lifer/core/species/inference.js";
import { photoVectors } from "@lifer/core/species/vectorCache.js";
import { getOrCreateLocalUser } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { TUS_INITIAL_CHUNK_SIZE } from "../lib/tusClient.js";
import { sendCaptureToServer } from "../settings/uploadToServer.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { parseRemoteJson } from "../offlinePacks/schemas.js";
import {
  CAPTURE_COLUMNS,
  captureFromRow,
  asSyncApply,
  isoStamp,
  upsertUserSpecies,
  USER_SPECIES_COLUMNS,
  userSpeciesFromRow,
  type PushedUserSpecies,
} from "./changes.js";
import { adoptServer, applyChanges, dropCaptures } from "./mirror.js";
import {
  pushLibraryDeletions,
  pushLibraryMembers,
  pushLibraryRows,
  waitingLibrary,
  type LibraryBody,
} from "./libraryMirror.js";
import { PushReplySchema, type PushedCapture, type PushedDeletions, type PushOutcome } from "./pushServer.js";
import { assertStillLinked, linkedServer, serverFetch, type LinkedServer } from "./serverLink.js";

const BATCH = 100;
const TOMBSTONE_BATCH = 1000;
// Photos bigger than this are matched by the server; reading them whole here isn't worth it.
const MAX_VECTOR_BYTES = 64 * 1024 * 1024;

export interface PushResult {
  pushed: number;
  uploaded: number;
  failed: number;
  unknownSpecies: number;
  /** Captures the server had changed too: its copy was taken here. */
  conflicts: number;
  userSpecies: number;
  /** Deletions sent. */
  deleted: number;
  /** Albums and trips the server took, and membership rows sent. */
  library: number;
}

type Db = Pick<Pool | PoolClient, "query">;

interface LocalCapture extends PushedCapture {
  localId: string;
  /** 'mirror' for a photo that came from the server: it has no files here to send. */
  origin: string;
  /** updated_at as read, to the microsecond: an edit made after this stays due. */
  updatedAt: string;
  files: {
    kind: "jpeg" | "raw" | "video" | "audio";
    ref: string;
    volume_id: string | null;
    volume_relative_path: string | null;
  }[];
}

async function unpushedCaptures(userId: string): Promise<LocalCapture[]> {
  const res = await pool.query(
    `SELECT c.id AS local_id, COALESCE(c.remote_id, c.id) AS id, c.origin, c.updated_at::text AS updated_at,
            ${isoStamp("c.remote_updated_at")} AS base, ${CAPTURE_COLUMNS},
            COALESCE((SELECT json_agg(json_build_object('kind', o.kind, 'ref', o.ref, 'volume_id', o.volume_id,
              'volume_relative_path', o.volume_relative_path) ORDER BY (o.kind = 'jpeg') DESC)
              FROM originals o WHERE o.capture_id = c.id), '[]') AS files
     FROM captures_all c JOIN species s ON s.id = c.species_id LEFT JOIN photos p ON p.id = c.current_photo_id
     WHERE c.user_id = $1 AND ((c.origin = 'local' AND c.pushed_at IS NULL) OR c.updated_at > c.pushed_at)
     ORDER BY c.updated_at, c.id`,
    [userId],
  );
  return res.rows.map((r) => {
    const { photo: _photo, ...capture } = captureFromRow(r);
    return { ...capture, baseUpdatedAt: r.base, localId: r.local_id, origin: r.origin, files: r.files };
  });
}

/** This computer's vectors for a photo, in the shape /uploads/inspect takes, or null. */
export async function clientVectorsForFile(filePath: string): Promise<string | null> {
  try {
    if ((await stat(filePath)).size > MAX_VECTOR_BYTES) return null;
    const bytes = await readFile(filePath);
    const kinds: PhotoVectorKind[] = ["clip", "clip-crop", "id-crop", "id"];
    const { vectors, subjectUnsure } = photoVectors(bytes, {
      kinds,
      key: contentHash(bytes),
      subject: true,
      priority: "background",
    });
    const out: ClientVectors = { pipelineVersion: EMBED_PIPELINE_VERSION, contentHash: contentHash(bytes) };
    const field = { clip: "clipFull", "clip-crop": "clipCrop", id: "idFull", "id-crop": "idCrop" } as const;
    const version = (kind: PhotoVectorKind) => (kind.startsWith("id") ? ID_MODEL_VERSION : EMBEDDING_MODEL_VERSION);
    for (const kind of kinds) {
      const v = await vectors[kind].catch(() => null);
      if (v) out[field[kind]] = { modelVersion: version(kind), b64f32: encodeVector(v) };
    }
    const unsure = await subjectUnsure;
    if (unsure != null) out.subjectUnsure = unsure;
    return out.clipFull || out.idCrop ? JSON.stringify(out) : null;
  } catch {
    return null;
  }
}

async function sendPush(
  server: LinkedServer,
  body: { captures: PushedCapture[]; userSpecies?: PushedUserSpecies[]; deleted?: PushedDeletions } & LibraryBody,
) {
  const res = await serverFetch(server, "/sync/push", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`The server's push answered ${res.status}`);
  return parseRemoteJson(PushReplySchema, await res.json(), "server's push answer");
}

const toPushed = ({ localId: _l, origin: _o, files: _f, updatedAt: _u, ...item }: LocalCapture): PushedCapture => item;

/** Uploads a capture's files like an import. The server's id for the capture, or null. */
async function uploadCapture(
  server: LinkedServer,
  c: LocalCapture,
  speciesId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const paths: Partial<Record<"jpeg" | "raw" | "video" | "audio", string>> = {};
  for (const f of c.files) {
    const resolved = await resolveOriginalPath(f);
    if (resolved.connected && resolved.path) paths[f.kind] = resolved.path;
  }
  const main = paths.jpeg ?? paths.video ?? paths.raw;
  if (!main) return null;
  const authHeaders = { "x-api-key": server.token, "x-lifer-client": "1" };
  // Vectors from this computer, so the server stores and verifies rather than matching again.
  // A RAW on its own is matched on its preview by the server; vectors from the RAW bytes wouldn't apply.
  const vectors = paths.jpeg ? await clientVectorsForFile(paths.jpeg) : null;
  let captureId: string | null = null;
  const ok = await sendCaptureToServer(
    server.baseUrl,
    authHeaders,
    { speciesId, photoPath: main, rawPath: paths.jpeg ? (paths.raw ?? null) : null },
    {
      signal,
      chunkState: { size: TUS_INITIAL_CHUNK_SIZE },
      clientVectors: vectors,
      onImported: (body) => {
        captureId = (body as { captureId?: string }).captureId ?? null;
      },
    },
  );
  return ok ? captureId : null;
}

/** Records a push of the capture as it was read; a null serverId or base keeps what it has. */
export async function markPushed(
  db: Db,
  localId: string,
  updatedAt: string,
  serverId: string | null = null,
  base: string | null = null,
): Promise<void> {
  await db.query(
    `UPDATE captures_all SET pushed_at = $2, remote_id = COALESCE($3, remote_id),
       remote_updated_at = COALESCE($4::timestamptz, remote_updated_at) WHERE id = $1`,
    [localId, updatedAt, serverId, base],
  );
}

async function unpushedUserSpecies(
  userId: string,
): Promise<{ rows: PushedUserSpecies[]; speciesIds: string[]; stamps: string[] }> {
  const res = await pool.query(
    `SELECT ${USER_SPECIES_COLUMNS}, us.species_id, us.updated_at::text AS stamp,
            ${isoStamp("us.remote_updated_at")} AS base
     FROM user_species us JOIN species s ON s.id = us.species_id
     WHERE us.user_id = $1 AND (us.pushed_at IS NULL OR us.updated_at > us.pushed_at)`,
    [userId],
  );
  return {
    // The mark's own version isn't sent, only the server's version it was based on.
    rows: res.rows.map((r) => ({ ...userSpeciesFromRow(r), updatedAt: undefined, baseUpdatedAt: r.base })),
    speciesIds: res.rows.map((r) => r.species_id),
    stamps: res.rows.map((r) => r.stamp),
  };
}

async function tombstones(userId: string, kind: "capture" | "user_species") {
  const res = await pool.query<{ id: string; ref: string; base: string | null }>(
    `SELECT id, ref, ${isoStamp("base")} AS base FROM sync_tombstones WHERE user_id = $1 AND kind = $2 ORDER BY id LIMIT $3`,
    [userId, kind, TOMBSTONE_BATCH],
  );
  return res.rows;
}

const forgetTombstones = (ids: string[]) =>
  pool.query(`DELETE FROM sync_tombstones WHERE id = ANY($1::bigint[])`, [ids]);

/** What's waiting for the server, by what the user sees: photos (with species marks, species
 *  corrections and their deletions), albums and trips. */
export async function waitingCounts(
  userId: string,
  db: Db = pool,
): Promise<{ photos: number; albums: number; trips: number }> {
  const res = await db.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM captures_all WHERE user_id = $1 AND ((origin = 'local' AND pushed_at IS NULL) OR updated_at > pushed_at))
          + (SELECT count(*) FROM user_species WHERE user_id = $1 AND (pushed_at IS NULL OR updated_at > pushed_at))
          + (SELECT count(*) FROM species_split_kept k JOIN captures_all c ON c.id = k.capture_id
             WHERE c.user_id = $1 AND (k.pushed_at IS NULL OR k.updated_at > k.pushed_at))
          + (SELECT count(*) FROM sync_tombstones WHERE user_id = $1 AND kind IN ('capture', 'user_species', 'species_split_kept')))::int AS n`,
    [userId],
  );
  return { photos: res.rows[0]?.n ?? 0, ...(await waitingLibrary(userId, db)) };
}

/** Everything waiting for the server. */
export async function unpushedCount(userId: string, db: Db = pool): Promise<number> {
  const { photos, albums, trips } = await waitingCounts(userId, db);
  return photos + albums + trips;
}

export const pushJob = createJob<PushResult>("sync-push");

/** Records the server's answer for one capture. A conflict takes the server's copy here now:
 *  the mirror's cursor may already be past it. */
async function settle(userId: string, o: PushOutcome, c: LocalCapture, totals: PushResult): Promise<void> {
  if (o.status === "updated") {
    await markPushed(pool, c.localId, c.updatedAt, o.serverId ?? null, o.updatedAt);
    totals.pushed++;
  } else if (o.status === "unknown-species") {
    totals.unknownSpecies++;
  } else if (o.status === "needs-file") {
    // Never on the server and already in the trash here, or a mirrored photo the server lost: nothing to send.
    await markPushed(pool, c.localId, c.updatedAt);
  } else {
    totals.conflicts++;
    await withTransaction(async (client) => {
      await markPushed(client, c.localId, c.updatedAt, o.serverId ?? null);
      if (o.current) await applyChanges(client, userId, [o.current], new Map(), "thumb");
      else await dropCaptures(client, userId, [{ id: o.id, deletedAt: new Date().toISOString(), base: null }]);
    });
  }
}

async function run(ctx: JobContext<PushResult>): Promise<PushResult> {
  const server = await linkedServer();
  if (!server) throw new Error("The linked server didn't answer");
  const userId = (await getOrCreateLocalUser()).id;
  await adoptServer(userId, server.instanceId);
  const totals: PushResult = {
    pushed: 0,
    uploaded: 0,
    failed: 0,
    unknownSpecies: 0,
    conflicts: 0,
    userSpecies: 0,
    deleted: 0,
    library: 0,
  };
  const sendLibrary = async (body: LibraryBody) => (await sendPush(server, { captures: [], ...body })).library;

  // Deletions first, so a photo deleted here and imported again isn't matched to its old copy.
  ctx.update({ phase: "deletions" });
  for (let gone = await tombstones(userId, "capture"); gone.length > 0; gone = await tombstones(userId, "capture")) {
    ctx.throwIfCancelled();
    assertStillLinked(server);
    await sendPush(server, {
      captures: [],
      deleted: { captures: gone.map((t) => ({ id: t.ref, baseUpdatedAt: t.base })) },
    });
    await forgetTombstones(gone.map((t) => t.id));
    totals.deleted += gone.length;
  }

  // Albums and trips before the captures that refer to them, their deletions with the rest.
  ctx.update({ phase: "albums" });
  assertStillLinked(server);
  totals.deleted += await pushLibraryDeletions(userId, sendLibrary);
  const rows = await pushLibraryRows(userId, sendLibrary);
  totals.library += rows.pushed;
  totals.conflicts += rows.conflicts;

  const captures = await unpushedCaptures(userId);
  ctx.update({ phase: "captures", total: captures.length, processed: 0 });
  for (let i = 0; i < captures.length; i += BATCH) {
    ctx.throwIfCancelled();
    assertStillLinked(server);
    const batch = captures.slice(i, i + BATCH);
    const byId = new Map(batch.map((c) => [c.id, c]));
    const { outcomes, speciesIds } = await sendPush(server, { captures: batch.map(toPushed) });
    const retry = new Map<string, LocalCapture>();
    for (const o of outcomes) {
      const c = byId.get(o.id);
      if (!c) continue;
      if (o.status !== "needs-file" || c.deletedAt || c.origin === "mirror") {
        await settle(userId, o, c, totals);
        continue;
      }
      const serverId = await uploadCapture(server, c, speciesIds[c.scientificName]!, ctx.signal).catch((err) => {
        log.warn({ err, captureId: c.localId }, "[sync] push: upload failed");
        return null;
      });
      if (!serverId) {
        log.warn(
          { captureId: c.localId },
          "[sync] push: the server didn't take the upload, or the original isn't connected",
        );
        totals.failed++;
        continue;
      }
      totals.uploaded++;
      if (serverId !== c.localId)
        await pool.query(`UPDATE captures_all SET remote_id = $2 WHERE id = $1`, [c.localId, serverId]);
      retry.set(serverId, { ...c, id: serverId });
    }
    // The uploaded ones exist now: their tags, rating and the rest go in a second pass.
    if (retry.size > 0) {
      const again = await sendPush(server, { captures: [...retry.values()].map(toPushed) });
      for (const o of again.outcomes) {
        const c = retry.get(o.id);
        if (c && o.status !== "needs-file") await settle(userId, o, c, totals);
      }
    }
    ctx.update({ processed: Math.min(i + BATCH, captures.length) });
  }

  // Membership after the captures it names are on the server.
  ctx.update({ phase: "membership" });
  assertStillLinked(server);
  totals.library += await pushLibraryMembers(userId, sendLibrary);

  ctx.update({ phase: "species" });
  const marks = await unpushedUserSpecies(userId);
  const unmarked = await tombstones(userId, "user_species");
  if (marks.rows.length > 0 || unmarked.length > 0) {
    const reply = await sendPush(server, {
      captures: [],
      userSpecies: marks.rows,
      deleted: { userSpecies: unmarked.map((t) => t.ref) },
    }).catch((err: Error) => {
      // The marks stay due, so the next push sends them again.
      throw new Error(`The server refused ${marks.rows.length} species marks: ${err.message}`);
    });
    totals.userSpecies = marks.rows.length;
    totals.deleted += unmarked.length;
    await forgetTombstones(unmarked.map((t) => t.id));
    const versions = reply.userSpeciesStamps ?? {};
    await pool.query(
      `UPDATE user_species us SET pushed_at = v.at, remote_updated_at = COALESCE(v.remote, us.remote_updated_at)
       FROM unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS v(species_id, at, remote)
       WHERE us.user_id = $1 AND us.species_id = v.species_id`,
      [userId, marks.speciesIds, marks.stamps, marks.rows.map((r) => versions[r.scientificName] ?? null)],
    );
    // Changed on the server since this copy: its mark wins, taken here now.
    const conflicts = reply.userSpeciesConflicts ?? [];
    if (conflicts.length > 0) {
      totals.conflicts += conflicts.length;
      await withTransaction(async (client) => {
        await asSyncApply(client);
        await upsertUserSpecies(client, userId, conflicts, { mirrored: true, force: true });
      });
    }
  }
  log.info(
    `[sync] push: ${totals.pushed} captures updated on the server, ${totals.uploaded} uploaded, ${totals.failed} failed, ${totals.conflicts} taken from the server (changed on both sides), ${totals.unknownSpecies} with a species the server lacks, ${totals.userSpecies} species marks, ${totals.library} albums, trips and album photos, ${totals.deleted} deletions`,
  );
  // Each one stays due, so the next push tries it again.
  if (totals.failed > 0)
    throw new Error(
      `${totals.failed} ${totals.failed === 1 ? "photo" : "photos"} couldn't be sent to the server and will be tried again at the next sync`,
    );
  return totals;
}

export function startPush(): boolean {
  return pushJob.start(run);
}
