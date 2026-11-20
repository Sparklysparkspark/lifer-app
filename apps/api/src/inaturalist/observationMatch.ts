// Finds the user's own iNaturalist observations among their photos: reads the observations into a
// local cache (observationSync.ts), filters pairs cheaply (matching.ts), then compares the pictures
// with the CLIP vectors Lifer already keeps for species matching and near-duplicates.
import sharp from "sharp";
import { pool } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { log } from "@lifer/core/lib/log.js";
import { isModelDownloaded, photoVectors } from "@lifer/core/species/embeddings.js";
import { fetchJwt } from "./client.js";
import {
  candidatePairs,
  decide,
  SAME,
  settle,
  previewUrl,
  type Candidate,
  type LocalCapture,
  type Match,
  type RemoteObservation,
} from "./matching.js";
import { fetchDeletedObservationIds, fetchObservationPages, fetchPreview, type NetDeps } from "./observationSync.js";

export interface Progress {
  phase: "reading" | "comparing";
  processed: number;
  total: number;
}

/** Stores observations as read, replacing older copies. */
export async function storeObservations(userId: string, page: RemoteObservation[]): Promise<void> {
  if (page.length === 0) return;
  await pool.query(
    `INSERT INTO inaturalist_remote_observations (user_id, inat_observation_id, data, updated_at)
     SELECT $1, (x->>'id')::bigint, x, (x->>'updatedAt')::timestamptz FROM jsonb_array_elements($2::jsonb) x
     ON CONFLICT (user_id, inat_observation_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [userId, JSON.stringify(page)],
  );
}

/** Forgets observations deleted on iNaturalist, and unlinks photos only found there. */
async function forgetObservations(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `DELETE FROM inaturalist_remote_observations WHERE user_id = $1 AND inat_observation_id = ANY($2::bigint[])`,
    [userId, ids],
  );
  await pool.query(
    `DELETE FROM capture_inaturalist_observations o USING captures_all c
     WHERE c.id = o.capture_id AND c.user_id = $1 AND o.source = 'inaturalist' AND o.inat_observation_id = ANY($2::text[])`,
    [userId, ids],
  );
}

/** A new sign-in starts the cache again: it may be another iNaturalist account. */
export async function resetObservationCache(userId: string): Promise<void> {
  await pool.query(`DELETE FROM inaturalist_remote_observations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM inaturalist_photo_embeddings WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE user_inaturalist_accounts SET observations_synced_at = NULL WHERE user_id = $1`, [userId]);
}

/** Reads what changed on iNaturalist since the last read (everything, the first time, resuming
 *  from the last id kept if that was cut short). Returns how many observations were read. */
export async function syncObservations(
  userId: string,
  accessToken: string,
  onProgress: (p: Progress) => void,
  deps: NetDeps = {},
): Promise<number> {
  const acct = (
    await pool.query<{ inat_user_id: string; synced_at: string | null; max_id: string | null }>(
      `SELECT a.inat_user_id, a.observations_synced_at::text AS synced_at,
              (SELECT max(inat_observation_id)::text FROM inaturalist_remote_observations r WHERE r.user_id = a.user_id) AS max_id
       FROM user_inaturalist_accounts a WHERE a.user_id = $1`,
      [userId],
    )
  ).rows[0];
  if (!acct) throw new Error("iNaturalist account not connected");
  const startedAt = new Date().toISOString();
  const jwt = await fetchJwt(accessToken);
  // A few minutes of overlap, so an edit made during the last read isn't missed.
  const since = acct.synced_at ? new Date(Date.parse(acct.synced_at) - 10 * 60_000).toISOString() : null;
  const read = await fetchObservationPages(
    {
      inatUserId: acct.inat_user_id,
      jwt,
      idAbove: since ? 0 : Number(acct.max_id ?? 0),
      updatedSince: since,
      onPage: async (page, p) => {
        await storeObservations(userId, page);
        onProgress({ phase: "reading", processed: p.read, total: p.total });
      },
    },
    deps,
  );
  if (since) {
    try {
      await forgetObservations(userId, await fetchDeletedObservationIds(jwt, since, deps));
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      log.warn(`[inaturalist] couldn't ask which observations were deleted: ${(err as Error).message}`);
    }
  }
  await pool.query(`UPDATE user_inaturalist_accounts SET observations_synced_at = $2 WHERE user_id = $1`, [
    userId,
    startedAt,
  ]);
  return read;
}

// ---- Comparing pictures ----

type Vectors = Float32Array[];
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};
/** The best cosine similarity between any vector of one picture and any of the other. */
export const bestSimilarity = (a: Vectors, b: Vectors): number =>
  Math.max(-1, ...a.flatMap((x) => b.map((y) => dot(x, y))));

/** Whole photo and subject crop, the two views the previews are stored as. */
async function previewVectors(bytes: Buffer): Promise<{ whole: Float32Array; crop: Float32Array }> {
  const { vectors } = photoVectors(bytes, { kinds: ["clip", "clip-crop"], priority: "background" });
  return { whole: await vectors.clip, crop: await vectors["clip-crop"] };
}

/** An observation photo's vectors, from the cache or by downloading its small preview once. */
async function observationPhotoVectors(
  userId: string,
  photo: RemoteObservation["photos"][number],
  deps: NetDeps,
): Promise<Vectors | null> {
  const hit = await pool.query<{ embedding: number[]; crop_embedding: number[] }>(
    `SELECT embedding, crop_embedding FROM inaturalist_photo_embeddings
     WHERE user_id = $1 AND inat_photo_id = $2 AND model_version = $3`,
    [userId, photo.id, EMBEDDING_MODEL_VERSION],
  );
  if (hit.rows[0]) return [Float32Array.from(hit.rows[0].embedding), Float32Array.from(hit.rows[0].crop_embedding)];
  const url = previewUrl(photo.url);
  if (!url) return null;
  const v = await previewVectors(await fetchPreview(url, deps));
  await pool.query(
    `INSERT INTO inaturalist_photo_embeddings (user_id, inat_photo_id, embedding, crop_embedding, model_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, inat_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding,
       crop_embedding = EXCLUDED.crop_embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
    [userId, photo.id, Array.from(v.whole), Array.from(v.crop), EMBEDDING_MODEL_VERSION],
  );
  return [v.whole, v.crop];
}

// The upload may be a crop: the photo is also compared in overlapping tiles at two scales, and the
// best score wins. Kept for the run (a few MB at most), not stored.
const TILE_GRIDS: Array<[size: number, stride: number]> = [
  [0.6, 0.2],
  [0.4, 0.3],
];
const tileMemo = new Map<string, Vectors>();
const TILE_MEMO_MAX = 400;

async function tileVectors(captureId: string, displayPath: string): Promise<Vectors> {
  const hit = tileMemo.get(captureId);
  if (hit) return hit;
  const image = sharp(displayPath);
  const { width = 0, height = 0 } = await image.metadata();
  const out: Vectors = [];
  const { vectors } = photoVectors({ path: displayPath }, { kinds: ["clip-crop"], priority: "background" });
  out.push(await vectors["clip-crop"]);
  for (const [size, stride] of TILE_GRIDS) {
    for (let fy = 0; fy < 3; fy++)
      for (let fx = 0; fx < 3; fx++) {
        const tile = await sharp(displayPath)
          .extract({
            left: Math.round(width * stride * fx),
            top: Math.round(height * stride * fy),
            width: Math.round(width * size),
            height: Math.round(height * size),
          })
          .jpeg({ quality: 90 })
          .toBuffer();
        out.push(await photoVectors(tile, { kinds: ["clip"], priority: "background" }).vectors.clip);
      }
  }
  tileMemo.set(captureId, out);
  if (tileMemo.size > TILE_MEMO_MAX) tileMemo.delete(tileMemo.keys().next().value!);
  return out;
}

// Only the closest few in a burst are tiled (about 20 model runs each).
const TILE_TOP = 8;
const TILE_FLOOR = 0.7;

/** Similarity of each candidate to the observation's photos: the whole photo's stored vector
 *  first, then tiles for the leaders when there's a choice to make or the score is short of sure. */
export async function scoreCandidates(
  userId: string,
  obs: RemoteObservation,
  pairs: Array<{ capture: LocalCapture; evidence: Candidate["evidence"] }>,
  deps: NetDeps,
): Promise<{ candidates: Candidate[]; complete: boolean }> {
  const remote: Vectors[] = [];
  // A handful of photos per observation at most.
  for (const photo of obs.photos.slice(0, 4)) {
    deps.signal?.throwIfAborted();
    const v = await observationPhotoVectors(userId, photo, deps).catch((err) => {
      if (deps.signal?.aborted) throw err;
      log.warn(`[inaturalist] couldn't compare observation photo ${photo.id}: ${(err as Error).message}`);
      return null;
    });
    if (v) remote.push(v);
  }
  if (remote.length === 0)
    return {
      candidates: pairs.map((p) => ({ captureId: p.capture.id, evidence: p.evidence, similarity: null, perPhoto: [] })),
      complete: false,
    };

  const ids = pairs.map((p) => p.capture.id);
  const rows = await pool.query<{ id: string; embedding: number[] | null; display_path: string | null }>(
    `SELECT c.id, e.embedding, p.display_path
     FROM captures c
     LEFT JOIN capture_embeddings e ON e.capture_id = c.id AND e.model_version = $2
     LEFT JOIN photos p ON p.id = c.current_photo_id
     WHERE c.id = ANY($1::uuid[])`,
    [ids, EMBEDDING_MODEL_VERSION],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const scored: Array<Candidate & { path: string | null }> = [];
  const score = (s: Candidate, local: Vectors) => {
    s.perPhoto = remote.map((r, j) => Math.max(s.perPhoto[j] ?? -1, bestSimilarity(r, local)));
    s.similarity = Math.max(...s.perPhoto);
  };
  for (const p of pairs) {
    const row = byId.get(p.capture.id);
    let whole: Float32Array | null = row?.embedding ? Float32Array.from(row.embedding) : null;
    if (!whole && row?.display_path)
      whole = await photoVectors(
        { path: row.display_path },
        { kinds: ["clip"], priority: "background" },
      ).vectors.clip.catch(() => null);
    const s: Candidate & { path: string | null } = {
      captureId: p.capture.id,
      evidence: p.evidence,
      similarity: null,
      perPhoto: [],
      path: row?.display_path ?? null,
    };
    if (whole) score(s, [whole]);
    scored.push(s);
  }
  const near = scored
    .filter((s) => s.similarity !== null && s.similarity >= TILE_FLOOR && s.path)
    .sort((a, b) => b.similarity! - a.similarity!);
  const leaders = near.slice(0, TILE_TOP);
  // With a choice to make, a crop can favour the wrong frame on the whole photo, so the leaders are
  // all tiled. One candidate is tiled only to lift a crop that falls short of sure.
  if (leaders.length > 1 || (leaders.length === 1 && leaders[0].similarity! < SAME)) {
    for (const s of leaders) {
      deps.signal?.throwIfAborted();
      const tiles = await tileVectors(s.captureId, s.path!).catch(() => null);
      if (tiles) score(s, tiles);
    }
  }
  return {
    candidates: scored.map(({ path: _path, ...c }) => c),
    // Close candidates left untiled could be the real frame: then nothing links on its own.
    complete: near.length <= TILE_TOP && scored.every((s) => s.similarity !== null),
  };
}

// ---- The whole pass ----

export async function loadLocalCaptures(userId: string, only?: string[]): Promise<LocalCapture[]> {
  const res = await pool.query<{
    id: string;
    inat_taxon_id: number | null;
    taken_at: Date | null;
    taken_at_zoned: boolean | null;
    lat: string | null;
    lon: string | null;
    width: number | null;
    height: number | null;
  }>(
    `SELECT c.id, s.inat_taxon_id, c.taken_at, c.taken_at_zoned, c.lat, c.lon, p.width, p.height
     FROM captures c
     JOIN species s ON s.id = c.species_id
     LEFT JOIN photos p ON p.id = c.current_photo_id
     WHERE c.user_id = $1 AND s.inat_taxon_id IS NOT NULL AND c.taken_at IS NOT NULL
       AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM capture_inaturalist_observations o WHERE o.capture_id = c.id)`,
    [userId, only ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    taxonId: r.inat_taxon_id,
    takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    zoned: r.taken_at_zoned,
    lat: r.lat === null ? null : Number(r.lat),
    lon: r.lon === null ? null : Number(r.lon),
    width: r.width,
    height: r.height,
  }));
}

export async function loadObservations(userId: string, only?: string[]): Promise<RemoteObservation[]> {
  const res = await pool.query<{ data: RemoteObservation }>(
    `SELECT data FROM inaturalist_remote_observations
     WHERE user_id = $1 AND ($2::bigint[] IS NULL OR inat_observation_id = ANY($2::bigint[]))`,
    [userId, only ?? null],
  );
  return res.rows.map((r) => r.data);
}

/** Finds pairs, compares them, and returns which to link and which to offer for review.
 *  `captureIds` narrows it to photos about to be sent. Writes nothing. */
export async function findMatches(
  userId: string,
  opts: { captureIds?: string[]; observationIds?: string[]; onProgress?: (p: Progress) => void },
  deps: NetDeps = {},
): Promise<{ links: Match[]; review: Match[]; compared: boolean }> {
  const [captures, observations, linkedRes, notRes] = await Promise.all([
    loadLocalCaptures(userId, opts.captureIds),
    loadObservations(userId, opts.observationIds),
    pool.query<{ inat_observation_id: string; n: number; sent: boolean }>(
      `SELECT o.inat_observation_id, count(*)::int AS n, bool_or(o.source IS NULL) AS sent
       FROM capture_inaturalist_observations o JOIN captures_all c ON c.id = o.capture_id
       WHERE c.user_id = $1 GROUP BY o.inat_observation_id`,
      [userId],
    ),
    pool.query<{ capture_id: string; inat_observation_id: string; kind: string }>(
      `SELECT n.capture_id, n.inat_observation_id, n.kind FROM capture_inaturalist_not_matches n
       JOIN captures_all c ON c.id = n.capture_id WHERE c.user_id = $1`,
      [userId],
    ),
  ]);
  const linked = new Map(linkedRes.rows.map((r) => [r.inat_observation_id, r]));
  const pairs = candidatePairs(captures, observations, {
    notMatches: new Set(
      notRes.rows.filter((r) => r.kind === "not_match").map((r) => `${r.capture_id}:${r.inat_observation_id}`),
    ),
    // Observations Lifer sent already have their photos.
    skipObservations: new Set(linkedRes.rows.filter((r) => r.sent).map((r) => r.inat_observation_id)),
  });
  const byId = new Map(observations.map((o) => [o.id, o]));
  const unlinked = new Set(
    notRes.rows.filter((r) => r.kind === "unlinked").map((r) => `${r.capture_id}:${r.inat_observation_id}`),
  );
  const model = isModelDownloaded();
  const results: Array<{ links: Match[]; review: Match[] }> = [];
  let processed = 0;
  for (const [obsId, list] of pairs) {
    deps.signal?.throwIfAborted();
    const obs = byId.get(obsId)!;
    const { candidates, complete }: { candidates: Candidate[]; complete: boolean } = model
      ? await scoreCandidates(userId, obs, list, deps)
      : {
          candidates: list.map((p) => ({
            captureId: p.capture.id,
            evidence: p.evidence,
            similarity: null,
            perPhoto: [],
          })),
          complete: false,
        };
    const capacity = complete ? obs.photos.length - (linked.get(obsId)?.n ?? 0) : 0;
    for (const c of candidates) if (unlinked.has(`${c.captureId}:${obsId}`)) c.noAuto = true;
    results.push(decide(obsId, candidates, capacity));
    opts.onProgress?.({ phase: "comparing", processed: ++processed, total: pairs.size });
  }
  return { ...settle(results), compared: model };
}

/** Links photos to observations found on iNaturalist, marked as found there. */
export async function linkFound(links: Array<{ captureId: string; observationId: string }>): Promise<string[]> {
  const linkedObs = new Set<string>();
  for (const l of links) {
    const res = await pool.query(
      `INSERT INTO capture_inaturalist_observations (capture_id, inat_observation_id, photo_sent, source)
       VALUES ($1, $2, true, 'inaturalist') ON CONFLICT (capture_id) DO NOTHING`,
      [l.captureId, l.observationId],
    );
    if (res.rowCount) linkedObs.add(l.observationId);
  }
  // A not-a-match left on a pair the user linked by hand no longer applies.
  if (links.length > 0)
    await pool.query(`DELETE FROM capture_inaturalist_not_matches WHERE capture_id = ANY($1::uuid[])`, [
      links.map((l) => l.captureId),
    ]);
  return [...linkedObs];
}
