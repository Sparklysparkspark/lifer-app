// Your own photos' vectors: one in-memory copy of each capture's stored vector, shared by
// suggestions, the near-duplicate check and Gallery search, plus which of a user's captures have
// one. Checked against computed_at; bounded by a float budget, LRU.
import type { Pool, PoolClient } from "pg";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { idModel } from "./idModel.js";
import type { ImageSource, Priority } from "./inference.js";
import { photoVector } from "./vectorCache.js";
import { CLIP_SPACE, ID_SPACE, type VectorSpace } from "./vectorSpaces.js";

type CaptureTable = VectorSpace["captureTable"];
// Your own photos ranked per species: the newest this many.
const YOUR_PHOTOS_MAX = 20;
const CAPTURE_VECTOR_BUDGET_FLOATS = (Number(process.env.LIFER_VECTOR_CACHE_MB) || 128) * 262_144;
const yourVectorCache = new Map<string, { computedAt: string; vec: Float32Array }>();
let yourVectorFloats = 0;
// Suggestions, the near-duplicate check or Gallery search last used any of these caches.
let lastSuggestionUse = 0;

export function noteSuggestionUse(): void {
  lastSuggestionUse = Date.now();
}

/** When suggestions last used these caches, so they can be freed once idle (suggest.ts). */
export function lastSuggestionUseAt(): number {
  return lastSuggestionUse;
}

/** Test and memory hook: forget every cached capture vector. */
export function clearYourVectorCache(): void {
  yourVectorCache.clear();
  yourVectorFloats = 0;
}

function putCaptureVector(table: CaptureTable, captureId: string, computedAt: string, vec: Float32Array): void {
  const key = `${table}:${captureId}`;
  const old = yourVectorCache.get(key);
  if (old) {
    yourVectorCache.delete(key);
    yourVectorFloats -= old.vec.length;
  }
  yourVectorCache.set(key, { computedAt, vec });
  yourVectorFloats += vec.length;
  while (yourVectorFloats > CAPTURE_VECTOR_BUDGET_FLOATS && yourVectorCache.size > 1) {
    const [oldestKey, oldest] = yourVectorCache.entries().next().value!;
    yourVectorCache.delete(oldestKey);
    yourVectorFloats -= oldest.vec.length;
  }
}

/** The stored vectors for these captures (as of each row's computed_at), from memory where
 * possible and from `table` for the rest. Rows without a stored vector are left out. */
export async function captureVectors(
  pool: Pool | PoolClient,
  table: CaptureTable,
  modelVersion: string,
  rows: ReadonlyArray<{ capture_id: string; computed_at: string | null }>,
): Promise<Map<string, Float32Array>> {
  noteSuggestionUse();
  const out = new Map<string, Float32Array>();
  const missing: string[] = [];
  for (const r of rows) {
    if (!r.computed_at) continue;
    const key = `${table}:${r.capture_id}`;
    const hit = yourVectorCache.get(key);
    if (hit && hit.computedAt === r.computed_at) {
      yourVectorCache.delete(key); // most recently used
      yourVectorCache.set(key, hit);
      out.set(r.capture_id, hit.vec);
    } else missing.push(r.capture_id);
  }
  const wanted = new Map(rows.map((r) => [r.capture_id, r.computed_at]));
  for (let i = 0; i < missing.length; i += 2000) {
    const res = await pool.query<{ capture_id: string; embedding: number[]; computed_at: string }>(
      `SELECT capture_id, embedding, computed_at::text AS computed_at FROM ${table} WHERE capture_id = ANY($1::uuid[]) AND model_version = $2`,
      [missing.slice(i, i + 2000), modelVersion],
    );
    for (const v of res.rows) {
      const vec = Float32Array.from(v.embedding);
      putCaptureVector(table, v.capture_id, v.computed_at, vec);
      if (wanted.get(v.capture_id) === v.computed_at) out.set(v.capture_id, vec);
    }
  }
  return out;
}

// Which of the user's captures have a vector, newest first. Kept current by the store functions
// and invalidateUserVectors; the TTL is only a safety net.
interface UserVectorRow {
  capture_id: string;
  species_id: string;
  computed_at: string;
}
const USER_INDEX_TTL_MS = 6 * 60 * 60_000;
const userIndexes = new Map<string, { at: number; rows: Promise<UserVectorRow[]>; resolved: UserVectorRow[] | null }>();
const userIndexKey = (userId: string, table: CaptureTable, modelVersion: string) =>
  `${userId}|${table}|${modelVersion}`;

export function userIndex(
  pool: Pool | PoolClient,
  userId: string,
  table: CaptureTable,
  modelVersion: string,
): Promise<UserVectorRow[]> {
  const key = userIndexKey(userId, table, modelVersion);
  const hit = userIndexes.get(key);
  if (hit && Date.now() - hit.at < USER_INDEX_TTL_MS) return hit.rows;
  const rows = pool
    .query<UserVectorRow>(
      `SELECT ce.capture_id, c.species_id, ce.computed_at::text AS computed_at
         FROM ${table} ce JOIN captures c ON c.id = ce.capture_id
        WHERE c.user_id = $1 AND ce.model_version = $2
        ORDER BY ce.computed_at DESC`,
      [userId, modelVersion],
    )
    .then((res) => res.rows);
  const entry = { at: Date.now(), rows, resolved: null as UserVectorRow[] | null };
  userIndexes.set(key, entry);
  rows.then(
    (r) => (entry.resolved = r),
    () => {
      if (userIndexes.get(key) === entry) userIndexes.delete(key);
    },
  );
  return rows;
}

// The species a user has photographed (the no-region candidate list), same lifetime rules.
const userSpeciesSets = new Map<string, { at: number; ids: Promise<Set<string>>; resolved: Set<string> | null }>();

export function userSpeciesIds(pool: Pool | PoolClient, userId: string): Promise<Set<string>> {
  const hit = userSpeciesSets.get(userId);
  if (hit && Date.now() - hit.at < USER_INDEX_TTL_MS) return hit.ids;
  const ids = pool
    .query<{ species_id: string }>(`SELECT species_id FROM user_species WHERE user_id = $1`, [userId])
    .then((res) => new Set(res.rows.map((r) => r.species_id)));
  const entry = { at: Date.now(), ids, resolved: null as Set<string> | null };
  userSpeciesSets.set(userId, entry);
  ids.then(
    (s) => (entry.resolved = s),
    () => {
      if (userSpeciesSets.get(userId) === entry) userSpeciesSets.delete(userId);
    },
  );
  return ids;
}

/** Frees every user index and cached capture vector. */
export function clearUserVectorCaches(): void {
  userIndexes.clear();
  userSpeciesSets.clear();
  clearYourVectorCache();
}

/** Forget what's cached about one user's photos. Call after anything that changes which species
 * a capture is, or removes, trashes or restores one; storing a new vector updates it already. */
export function invalidateUserVectors(userId: string): void {
  for (const key of [...userIndexes.keys()]) if (key.startsWith(`${userId}|`)) userIndexes.delete(key);
  userSpeciesSets.delete(userId);
}

function noteStoredVector(
  space: VectorSpace,
  captureId: string,
  row: { user_id: string; species_id: string; computed_at: string } | undefined,
  vec: Float32Array,
): void {
  if (!row) return;
  putCaptureVector(space.captureTable, captureId, row.computed_at, vec);
  const key = userIndexKey(row.user_id, space.captureTable, space.modelVersion);
  const index = userIndexes.get(key);
  if (index?.resolved) {
    const i = index.resolved.findIndex((r) => r.capture_id === captureId);
    if (i >= 0) index.resolved.splice(i, 1);
    index.resolved.unshift({ capture_id: captureId, species_id: row.species_id, computed_at: row.computed_at });
  } else if (index) userIndexes.delete(key); // still loading: read it again next time
  const species = userSpeciesSets.get(row.user_id);
  if (species && !species.resolved?.has(row.species_id)) userSpeciesSets.delete(row.user_id);
}

export async function yourVectorsBySpecies(
  pool: Pool | PoolClient,
  userId: string,
  space: VectorSpace,
): Promise<Map<string, Float32Array[]>> {
  const rows = await userIndex(pool, userId, space.captureTable, space.modelVersion);
  const perSpecies = new Map<string, number>();
  const newest: UserVectorRow[] = [];
  for (const r of rows) {
    const n = perSpecies.get(r.species_id) ?? 0;
    if (n >= YOUR_PHOTOS_MAX) continue;
    perSpecies.set(r.species_id, n + 1);
    newest.push(r);
  }
  const vectors = await captureVectors(pool, space.captureTable, space.modelVersion, newest);
  const bySpecies = new Map<string, Float32Array[]>();
  for (const r of newest) {
    const vec = vectors.get(r.capture_id);
    if (!vec) continue;
    if (!bySpecies.has(r.species_id)) bySpecies.set(r.species_id, []);
    bySpecies.get(r.species_id)!.push(vec);
  }
  return bySpecies;
}

/** Starts reading a user's stored CLIP vectors into memory, for a near-duplicate check that
 * will need them in a moment. */
export function prefetchUserVectors(pool: Pool | PoolClient, userId: string): void {
  userIndex(pool, userId, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion)
    .then((rows) => captureVectors(pool, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion, rows))
    .catch(() => {});
}

async function storeVectorRow(
  client: Pool | PoolClient,
  table: CaptureTable,
  captureId: string,
  embedding: ArrayLike<number>,
  modelVersion: string,
): Promise<{ user_id: string; species_id: string; computed_at: string } | undefined> {
  const res = await client.query<{ user_id: string; species_id: string; computed_at: string }>(
    `WITH stored AS (
       INSERT INTO ${table} (capture_id, embedding, model_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (capture_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()
       RETURNING capture_id, computed_at)
     SELECT c.user_id, c.species_id, stored.computed_at::text AS computed_at FROM stored JOIN captures c ON c.id = stored.capture_id`,
    [captureId, Array.from(embedding), modelVersion],
  );
  return res.rows[0];
}

export async function storeCaptureEmbedding(
  client: Pool | PoolClient,
  captureId: string,
  embedding: ArrayLike<number>,
): Promise<void> {
  const row = await storeVectorRow(client, "capture_embeddings", captureId, embedding, EMBEDDING_MODEL_VERSION);
  noteStoredVector(CLIP_SPACE, captureId, row, Float32Array.from(embedding));
}

/** Stores a capture's identification-model vector. A no-op when the model isn't downloaded.
 * `key` is the photo's sha256 when known, so an already computed vector is reused. */
export async function storeIdCaptureEmbedding(
  client: Pool | PoolClient,
  captureId: string,
  image: ImageSource,
  opts: { priority?: Priority; key?: string | null } = {},
): Promise<void> {
  if (!idModel.isDownloaded()) return;
  const embedding = await photoVector("id-crop", image, { key: opts.key, priority: opts.priority ?? "background" });
  const row = await storeVectorRow(client, "id_model_capture_embeddings", captureId, embedding, ID_MODEL_VERSION);
  noteStoredVector(ID_SPACE, captureId, row, embedding);
}
