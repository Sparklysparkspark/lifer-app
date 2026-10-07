// Species auto-suggest: local nearest-neighbor search over image embeddings, nothing leaves the
// device. The embedded Postgres has no pgvector, so vectors are plain real[] columns and ranking
// is brute-force cosine similarity in JS, which is fast enough at personal-library scale.
//
// Vectors stay Float32Array in here. The number[] helpers exist for callers that write straight
// to Postgres, which would send a typed array as bytea rather than real[].
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { APP_DATA_DIR, EMBEDDING_MODEL_GPU_BYTES, EMBEDDING_MODEL_GPU_URL, EMBEDDING_MODEL_URL, EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { parseClientVectors } from "./clientVectors.js";
import { idModel } from "./idModel.js";
import {
  analyzeImage,
  contentHash,
  isInferenceStuck as inferenceStuck,
  releaseModels,
  warmModels,
  type ImageSource,
  type Priority,
  type SubjectPresence,
  type TextModelSpec,
} from "./inference.js";
import { createOnnxImageModel, l2Normalize, type OnnxImageModel } from "./onnxImageModel.js";

export { l2Normalize };

// Opt-in download, never bundled. Holds the CLIP and identification models plus the text
// encoder cache, and is deleted wholesale on offload.
export const MODEL_DIR = path.join(APP_DATA_DIR, "models");

export const clipModel = createOnnxImageModel({
  path: path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`),
  url: EMBEDDING_MODEL_URL,
  label: "the species-matching model",
  missingMessage: "The species-matching model hasn't been downloaded (Settings > Offline Data)",
  family: "clip",
  gpuCopy: EMBEDDING_MODEL_GPU_URL ? { path: path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}-fp32.onnx`), url: EMBEDDING_MODEL_GPU_URL, bytes: EMBEDDING_MODEL_GPU_BYTES } : null,
});

/** Whether the CLIP vision model has been downloaded. Cheap enough to call on every poll. */
export function isModelDownloaded(): boolean {
  return clipModel.isDownloaded();
}

/** Deletes CLIP files left by an earlier EMBEDDING_MODEL_VERSION. True when there were any, which
 * means this install had opted in to species matching. */
export function dropOlderClipModels(): boolean {
  if (!existsSync(MODEL_DIR)) return false;
  const current = (f: string) => f.startsWith(`${EMBEDDING_MODEL_VERSION}.`) || f.startsWith(`${EMBEDDING_MODEL_VERSION}-`);
  const older = readdirSync(MODEL_DIR).filter((f) => f.startsWith("clip-vit-") && !current(f));
  for (const f of older) rmSync(path.join(MODEL_DIR, f), { force: true });
  return older.length > 0;
}

/** Deletes the whole model directory and frees every loaded session. Safe if nothing was downloaded. */
export function offloadModel(): void {
  rmSync(MODEL_DIR, { recursive: true, force: true });
  releaseModels(null);
}

/** Downloads the CLIP vision model (~307MB), resuming a partial file. */
export async function downloadModel(
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  await clipModel.download(onProgress, signal);
}

export function isInferenceStuck(): boolean {
  return inferenceStuck();
}

// ---------------------------------------------------------------------------------------------
// Per-photo vectors
// ---------------------------------------------------------------------------------------------

/** "clip" / "id": the whole photo through CLIP or the identification model. "clip-crop" /
 * "id-crop": cropped to the detected animal first. */
export type PhotoVectorKind = "clip" | "clip-crop" | "id" | "id-crop";

const modelFor = (kind: PhotoVectorKind): OnnxImageModel => (kind === "id" || kind === "id-crop" ? idModel : clipModel);
const isCropKind = (kind: PhotoVectorKind) => kind === "clip-crop" || kind === "id-crop";
const KIND_VERSION: Record<PhotoVectorKind, string> = {
  clip: EMBEDDING_MODEL_VERSION,
  "clip-crop": `${EMBEDDING_MODEL_VERSION}:p${EMBED_PIPELINE_VERSION}`,
  id: ID_MODEL_VERSION,
  "id-crop": `${ID_MODEL_VERSION}:p${EMBED_PIPELINE_VERSION}`,
};
/** The whole-photo vector that backs up each crop kind. */
const WHOLE_KIND = { "clip-crop": "clip", "id-crop": "id" } as const;
const memoKey = (kind: PhotoVectorKind, hash: string) => `${kind}:${KIND_VERSION[kind]}:${hash}`;

// Importing a photo needs the same vectors while checking it and again after saving it, so
// results are remembered by content hash. Keyed by model and pipeline version so an update
// never reuses old vectors.
const VECTOR_MEMO_BYTES = 64 * 1024 * 1024;
const ESTIMATED_VECTOR_BYTES = 768 * 4;
interface MemoEntry {
  value: Promise<Float32Array>;
  bytes: number;
}
const vectorMemo = new Map<string, MemoEntry>();
let vectorMemoBytes = 0;

function memoGet(key: string): Promise<Float32Array> | null {
  const hit = vectorMemo.get(key);
  if (!hit) return null;
  vectorMemo.delete(key); // move to the newest end
  vectorMemo.set(key, hit);
  return hit.value;
}

function memoDelete(key: string, entry: MemoEntry): void {
  if (vectorMemo.get(key) !== entry) return;
  vectorMemo.delete(key);
  vectorMemoBytes -= entry.bytes;
}

function memoSet(key: string, value: Promise<Float32Array>): void {
  const old = vectorMemo.get(key);
  if (old) memoDelete(key, old);
  const entry: MemoEntry = { value, bytes: ESTIMATED_VECTOR_BYTES };
  vectorMemo.set(key, entry);
  vectorMemoBytes += entry.bytes;
  value.then(
    (v) => {
      if (vectorMemo.get(key) !== entry) return;
      vectorMemoBytes += v.byteLength - entry.bytes;
      entry.bytes = v.byteLength;
    },
    () => memoDelete(key, entry), // a failure isn't worth remembering
  );
  while (vectorMemoBytes > VECTOR_MEMO_BYTES && vectorMemo.size > 1) {
    const [oldestKey, oldest] = vectorMemo.entries().next().value!;
    memoDelete(oldestKey, oldest);
  }
}

/** Whether a vector for this photo is already remembered (so committing it needs no image). */
export function hasRememberedVector(kind: PhotoVectorKind, key: string): boolean {
  return vectorMemo.has(memoKey(kind, key));
}

/** Seeds the memo with a vector computed elsewhere, e.g. by a desktop client. */
export function rememberPhotoVector(kind: PhotoVectorKind, key: string, vector: Float32Array): void {
  memoSet(memoKey(kind, key), Promise.resolve(vector));
}

/** Seeds the memo from a desktop client's clientVectors field for the photo whose sha256 is
 * `hash`. Returns why they were ignored, or null when they were taken. */
export function rememberClientVectors(raw: string, hash: string): string | null {
  const parsed = parseClientVectors(raw, {
    pipelineVersion: EMBED_PIPELINE_VERSION,
    contentHash: hash,
    modelVersions: { clip: EMBEDDING_MODEL_VERSION, "clip-crop": EMBEDDING_MODEL_VERSION, id: ID_MODEL_VERSION, "id-crop": ID_MODEL_VERSION },
  });
  if ("rejected" in parsed) return parsed.rejected;
  for (const [kind, vector] of Object.entries(parsed.vectors)) rememberPhotoVector(kind as PhotoVectorKind, hash, vector);
  if (parsed.subjectUnsure !== undefined) rememberSubjectUnsure(hash, parsed.subjectUnsure);
  return null;
}

// Whether the detector was unsure of each photo's subject, by content hash, so remembered
// photos don't need detection again.
const SUBJECT_MEMO_SIZE = 2000;
const subjectMemo = new Map<string, boolean>();
function rememberSubjectUnsure(hash: string, unsure: boolean): void {
  subjectMemo.delete(hash);
  subjectMemo.set(hash, unsure);
  if (subjectMemo.size > SUBJECT_MEMO_SIZE) subjectMemo.delete(subjectMemo.keys().next().value!);
}

const isBytes = (image: ImageSource): image is Uint8Array => image instanceof Uint8Array;

/** Any of `kinds` for one photo, computed in a single worker job unless already remembered.
 * `key` is the photo's sha256 when known. Every promise is safe to ignore. */
export function photoVectors(
  image: ImageSource,
  opts: { kinds: PhotoVectorKind[]; key?: string | null; presence?: boolean; subject?: boolean; priority: Priority },
): {
  vectors: Record<PhotoVectorKind, Promise<Float32Array>>;
  presence: Promise<SubjectPresence | null>;
  /** With `subject`: whether the detector was unsure it found the animal. */
  subjectUnsure: Promise<boolean | null>;
} {
  const hash = opts.key ?? (isBytes(image) ? contentHash(image) : null);
  const vectors = {} as Record<PhotoVectorKind, Promise<Float32Array>>;
  const missing: PhotoVectorKind[] = [];
  for (const kind of new Set(opts.kinds)) {
    const hit = hash ? memoGet(memoKey(kind, hash)) : null;
    if (hit) vectors[kind] = hit;
    else if (!modelFor(kind).isDownloaded()) vectors[kind] = Promise.reject(new Error(modelFor(kind).target(false).missingMessage));
    else missing.push(kind);
  }
  let presence: Promise<SubjectPresence | null> = Promise.resolve(null);
  const knownUnsure = hash ? subjectMemo.get(hash) : undefined;
  let subjectUnsure: Promise<boolean | null> = Promise.resolve(knownUnsure ?? null);
  const askSubject = !!opts.subject && knownUnsure === undefined;
  if (missing.length > 0 || opts.presence || askSubject) {
    const job = analyzeImage(image, {
      targets: missing.map((kind) => modelFor(kind).target(isCropKind(kind))),
      key: hash,
      presence: opts.presence,
      subject: askSubject || missing.some(isCropKind),
      priority: opts.priority,
    });
    const unsure = job.then((r) => {
      if (hash && r.subjectUnsure != null) rememberSubjectUnsure(hash, r.subjectUnsure);
      return r.subjectUnsure;
    });
    unsure.catch(() => {});
    if (askSubject) subjectUnsure = unsure.catch(() => null);
    missing.forEach((kind, i) => {
      const vector = job.then((r) => {
        const v = r.vectors[i];
        if (v instanceof Float32Array) return v;
        throw new Error(v.error);
      });
      vectors[kind] = vector;
      if (hash) memoSet(memoKey(kind, hash), vector);
    });
    if (opts.presence) presence = job.then((r) => r.presence, () => null);
  }
  for (const v of Object.values(vectors)) v.catch(() => {});
  return { vectors, presence, subjectUnsure };
}

/** The vectors a photo's suggestions rank from: its subject crop, plus the whole photo when the
 * detector was unsure, so a wrong crop can't decide alone. */
export async function suggestionVectors(
  image: ImageSource,
  kind: "clip-crop" | "id-crop",
  opts: { key?: string | null; priority: Priority },
): Promise<Float32Array[]> {
  const { vectors, subjectUnsure } = photoVectors(image, { kinds: [kind], key: opts.key, subject: true, priority: opts.priority });
  const crop = await vectors[kind];
  if (!(await subjectUnsure)) return [crop];
  const whole = await photoVector(WHOLE_KIND[kind], image, opts).catch(() => null);
  return whole ? [crop, whole] : [crop];
}

/** One photo vector (see PhotoVectorKind). */
export function photoVector(kind: PhotoVectorKind, image: ImageSource, opts: { key?: string | null; priority: Priority }): Promise<Float32Array> {
  return photoVectors(image, { kinds: [kind], key: opts.key, priority: opts.priority }).vectors[kind];
}

/** L2-normalized CLIP embedding of the whole photo, as a plain array. Background priority. */
export async function computeEmbedding(buffer: Buffer): Promise<number[]> {
  return Array.from(await photoVector("clip", buffer, { priority: "background" }));
}

/** CLIP embedding of the photo cropped to the detected animal. Suggestions only: near-duplicate
 * detection must stay uncropped to compare against uncropped capture_embeddings rows. */
export async function computeSuggestionEmbedding(buffer: Buffer): Promise<number[]> {
  return Array.from(await photoVector("clip-crop", buffer, { priority: "interactive" }));
}

/** The identification model's embedding of the subject-cropped photo, used for both queries and
 * stored capture vectors so the two sides are computed the same way. */
export async function computeIdSuggestionEmbedding(buffer: Buffer): Promise<number[]> {
  return Array.from(await photoVector("id-crop", buffer, { priority: "interactive" }));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized, so the dot product is the cosine similarity
}

// Soft demotion factors, not exclusions: a correct vagrant or off-season ID still wins when its
// visual match is clearly best; these only break near-ties toward species plausible to encounter.
const VAGRANT_SCORE_FACTOR = 0.88;
const TIER_SCORE_FACTOR: Partial<Record<string, number>> = {
  legendary: 0.94,
  rare: 0.96,
  uncommon: 0.98,
};
// Below this fraction of a species' peak-month occurrence, the photo's month counts as off-season.
// Relative because seasonality is stored as monthly shares, not raw counts.
const OFF_SEASON_RATIO = 0.05;
const OFF_SEASON_SCORE_FACTOR = 0.94;

// Matches against your own photos run hot regardless of species, because one library shares a
// camera, processing and compression that the embedding partly keys on. This discount offsets that.
const YOUR_PHOTOS_SCORE_FACTOR = 0.94;
const YOUR_PHOTOS_MAX = 20;

// Everything a species can be matched against: your own photos of it (discounted) and its
// reference and gallery photos. Best match wins.
export function matchTargets(row: {
  your_embeddings: ArrayLike<number>[] | null;
  ref_embedding: ArrayLike<number> | null;
  gallery_embeddings: ArrayLike<number>[] | null;
}): Array<{ embedding: ArrayLike<number>; factor: number; source: SpeciesSuggestion["source"] }> {
  return [
    ...(row.your_embeddings ?? []).map((embedding) => ({ embedding, factor: YOUR_PHOTOS_SCORE_FACTOR, source: "your_photos" as const })),
    ...[row.ref_embedding, ...(row.gallery_embeddings ?? [])]
      .filter((e): e is ArrayLike<number> => e != null)
      .map((embedding) => ({ embedding, factor: 1, source: "reference_photo" as const })),
  ];
}

// Weight of the zero-shot text signal (the photo against "a photo of a {species}"), blended with
// the image-to-image score. It is independent of the photo's background and lighting.
const TEXT_BLEND_WEIGHT = 0.7;

// The top pick is confident only when it beats the runner-up by CONFIDENCE_MARGIN: the margin,
// not the raw blended score, is what separates right from wrong. The floor only guards against
// having no signal at all. Tuned to err toward "not confident" rather than falsely certain.
const CONFIDENCE_FLOOR = 0.4;
const CONFIDENCE_MARGIN = 0.025;

// Which model's vectors a ranking runs on, with that model's own calibration (score ranges
// differ between CLIP and the identification model).
export interface VectorSpace {
  modelVersion: string;
  textModelVersion: string;
  captureTable: "capture_embeddings" | "id_model_capture_embeddings";
  referenceTable: "species_reference_embeddings" | "id_model_reference_embeddings";
  galleryTable: "species_reference_gallery_embeddings" | "id_model_gallery_embeddings";
  textTable: "species_text_embeddings" | "id_model_text_embeddings";
  textWeight: number;
  confidenceFloor: number;
  confidenceMargin: number;
  /** A margin that counts as fully decisive: scales matchPercent and cuts low-relevance alternatives. */
  marginScale: number;
}

// Must match TEXT_MODEL_VERSION in textEmbedding.ts (not imported, to keep this file free of the
// text model's transformers.js dependency).
const CLIP_TEXT_MODEL_VERSION = "clip-vit-l14-text-v2";

export const CLIP_SPACE: VectorSpace = {
  modelVersion: EMBEDDING_MODEL_VERSION,
  textModelVersion: CLIP_TEXT_MODEL_VERSION,
  captureTable: "capture_embeddings",
  referenceTable: "species_reference_embeddings",
  galleryTable: "species_reference_gallery_embeddings",
  textTable: "species_text_embeddings",
  textWeight: TEXT_BLEND_WEIGHT,
  confidenceFloor: CONFIDENCE_FLOOR,
  confidenceMargin: CONFIDENCE_MARGIN,
  marginScale: 0.05,
};

// Same meaning as CLIP's constants. This model's blended scores run higher, so the floor is
// higher, and it is still only a no-signal guard.
const ID_CONFIDENCE_FLOOR = 0.6;
const ID_CONFIDENCE_MARGIN = 0.027;
const ID_MARGIN_SCALE = 0.05;

export const ID_SPACE: VectorSpace = {
  modelVersion: ID_MODEL_VERSION,
  textModelVersion: ID_MODEL_VERSION,
  captureTable: "id_model_capture_embeddings",
  referenceTable: "id_model_reference_embeddings",
  galleryTable: "id_model_gallery_embeddings",
  textTable: "id_model_text_embeddings",
  textWeight: 0.7,
  confidenceFloor: ID_CONFIDENCE_FLOOR,
  confidenceMargin: ID_CONFIDENCE_MARGIN,
  marginScale: ID_MARGIN_SCALE,
};

/** Blends the image score with the candidate's text-prompt score, or returns the image score
 * when no text vector exists yet. */
function blendWithText(imageScore: number, embedding: ArrayLike<number>, textEmbedding: ArrayLike<number> | null, textWeight: number): number {
  if (!textEmbedding) return imageScore;
  const textScore = cosineSimilarity(embedding, textEmbedding);
  return (1 - textWeight) * imageScore + textWeight * textScore;
}

/** Marks the top candidate `confident` when it clears both the floor and the margin over the
 * runner-up. Mutates in place; expects `scored` sorted descending. */
function markConfidence(scored: SpeciesSuggestion[], space: VectorSpace): void {
  if (scored.length === 0) return;
  const runnerUpScore = scored[1]?.score ?? -Infinity;
  scored[0].confident = scored[0].score >= space.confidenceFloor && scored[0].score - runnerUpScore >= space.confidenceMargin;
}

const DISPLAY_BASE_PERCENT = 50;
const DISPLAY_TOP_PERCENT = 99;

/** Cuts the ranked list at the first item whose raw score trails the top pick's by more than the
 * space's marginScale. Comparing against the winner, not rank position, keeps a close cluster
 * visible even when small cross-platform inference noise reorders it. Expects `scored` sorted
 * descending. */
function trimLowRelevance(scored: SpeciesSuggestion[], limit: number, space: VectorSpace): SpeciesSuggestion[] {
  if (scored.length === 0) return [];
  const topScore = scored[0].score;
  let cutoff = scored.length;
  for (let i = 1; i < scored.length; i++) {
    if (topScore - scored[i].score >= space.marginScale) {
      cutoff = i;
      break;
    }
  }
  return scored.slice(0, Math.min(limit, cutoff));
}

/** Sets a display-only 0-100 `matchPercent` on every item. The raw blended score isn't a
 * meaningful percentage, so this cascades down the list by each item's margin over the next:
 * a decisive top pick reads high, a toss-up near 50%. Expects `scored` sorted descending. */
function assignDisplayPercents(scored: SpeciesSuggestion[], space: VectorSpace): void {
  const DISPLAY_MARGIN_SCALE = space.marginScale;
  for (let i = 0; i < scored.length; i++) {
    if (i === 0) {
      // No runner-up means nothing contradicts this pick: treat it as fully decisive.
      const margin = scored.length > 1 ? scored[0].score - scored[1].score : DISPLAY_MARGIN_SCALE;
      const t = Math.min(1, Math.max(0, margin / DISPLAY_MARGIN_SCALE));
      scored[0].matchPercent = Math.round(DISPLAY_BASE_PERCENT + t * (DISPLAY_TOP_PERCENT - DISPLAY_BASE_PERCENT));
      continue;
    }
    const margin = scored[i - 1].score - scored[i].score;
    const t = Math.min(1, Math.max(0, margin / DISPLAY_MARGIN_SCALE));
    // Always step down at least 5 points so two candidates never display as tied.
    const decrement = 5 + t * 40;
    scored[i].matchPercent = Math.max(2, scored[i - 1].matchPercent! - Math.round(decrement));
  }
}

export interface OccurrenceContext {
  isVagrant: boolean | null;
  localTier: string | null;
  seasonality: number[] | null;
}

// One combined multiplier, so several weak signals stack while a common species stays at 1.0.
function occurrenceAdjustment(ctx: OccurrenceContext, takenAt: Date | null): number {
  let factor = 1;
  if (ctx.isVagrant) factor *= VAGRANT_SCORE_FACTOR;
  if (ctx.localTier && TIER_SCORE_FACTOR[ctx.localTier]) factor *= TIER_SCORE_FACTOR[ctx.localTier]!;
  if (takenAt && ctx.seasonality && ctx.seasonality.length === 12) {
    const peak = Math.max(...ctx.seasonality);
    if (peak > 0) {
      const monthShare = ctx.seasonality[takenAt.getUTCMonth()] / peak;
      if (monthShare < OFF_SEASON_RATIO) factor *= OFF_SEASON_SCORE_FACTOR;
    }
  }
  return factor;
}

// ---------------------------------------------------------------------------------------------
// Your own photos' vectors
// ---------------------------------------------------------------------------------------------
// One in-memory copy of each capture's stored vector, shared by suggestions, the near-duplicate
// check and Gallery search. Checked against computed_at; bounded by a float budget, LRU.
type CaptureTable = VectorSpace["captureTable"];
const CAPTURE_VECTOR_BUDGET_FLOATS = (Number(process.env.LIFER_VECTOR_CACHE_MB) || 128) * 262_144;
const yourVectorCache = new Map<string, { computedAt: string; vec: Float32Array }>();
let yourVectorFloats = 0;
// Suggestions, the near-duplicate check or Gallery search last used any of these caches.
let lastSuggestionUse = 0;

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
  lastSuggestionUse = Date.now();
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
const userIndexKey = (userId: string, table: CaptureTable, modelVersion: string) => `${userId}|${table}|${modelVersion}`;

function userIndex(pool: Pool | PoolClient, userId: string, table: CaptureTable, modelVersion: string): Promise<UserVectorRow[]> {
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

function userSpeciesIds(pool: Pool | PoolClient, userId: string): Promise<Set<string>> {
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

/** Forget what's cached about one user's photos. Call after anything that changes which species
 * a capture is, or removes, trashes or restores one; storing a new vector updates it already. */
export function invalidateUserVectors(userId: string): void {
  for (const key of [...userIndexes.keys()]) if (key.startsWith(`${userId}|`)) userIndexes.delete(key);
  userSpeciesSets.delete(userId);
}

function noteStoredVector(space: VectorSpace, captureId: string, row: { user_id: string; species_id: string; computed_at: string } | undefined, vec: Float32Array): void {
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

async function yourVectorsBySpecies(pool: Pool | PoolClient, userId: string, space: VectorSpace): Promise<Map<string, Float32Array[]>> {
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

export interface NearDuplicate {
  capture_id: string;
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  taken_at: string | null;
}

/** The user's own photo that `embedding` (a whole-photo CLIP vector) is almost identical to: the
 * same shot re-processed, which a content hash can't catch. `threshold` sits well above ordinary
 * same-species similarity. */
export async function findNearDuplicate(pool: Pool | PoolClient, userId: string, embedding: ArrayLike<number>, threshold = 0.95): Promise<NearDuplicate | null> {
  const rows = await userIndex(pool, userId, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion);
  const vectors = await captureVectors(pool, CLIP_SPACE.captureTable, CLIP_SPACE.modelVersion, rows);
  const close: Array<{ captureId: string; score: number }> = [];
  for (const [captureId, vec] of vectors) {
    const score = cosineSimilarity(embedding, vec);
    if (score >= threshold) close.push({ captureId, score });
  }
  close.sort((a, b) => b.score - a.score);
  // Confirmed against the database, so a capture trashed since the cache was read never counts.
  for (const { captureId } of close) {
    const res = await pool.query<NearDuplicate>(
      `SELECT c.id AS capture_id, c.species_id, s.common_name, s.scientific_name, c.taken_at
         FROM captures c JOIN species s ON s.id = c.species_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [captureId, userId],
    );
    if (res.rows[0]) return res.rows[0];
  }
  return null;
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

export async function storeCaptureEmbedding(client: Pool | PoolClient, captureId: string, embedding: ArrayLike<number>): Promise<void> {
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

// Field names match SpeciesResult because the frontend treats a suggestion as one.
export interface SpeciesSuggestion {
  id: string;
  common_name: string | null;
  scientific_name: string;
  score: number;
  source: "your_photos" | "reference_photo" | "keyword_tag";
  /** Set only on the top-ranked candidate. Absent on a keyword_tag suggestion, an exact match. */
  confident?: boolean;
  /** 0-100, what the user sees instead of the raw score. Absent on a keyword_tag suggestion. */
  matchPercent?: number;
}

// ---------------------------------------------------------------------------------------------
// Candidate species
// ---------------------------------------------------------------------------------------------
// Candidate vectors are kept in memory because reading them from Postgres per suggestion is slow.
// One store per model holds each species once, and candidate sets (a region's checklist, or your
// species plus downloaded packs) reference into it so overlapping regions share. Dropped by
// invalidateSuggestionCache, refreshed per species by refreshSpeciesVectors, freed when idle.

interface SpeciesVectors {
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  ref_embedding: Float32Array | null;
  gallery_embeddings: Float32Array[] | null;
  text_embedding: Float32Array | null;
}

interface CandidateEntry {
  species: SpeciesVectors;
  is_vagrant: boolean | null;
  local_tier: string | null;
  seasonality: number[] | null;
}

interface SpeciesStore {
  /** null: no photo to show, so never a candidate (a blank suggestion card). */
  entries: Map<string, SpeciesVectors | null>;
  loading: Map<string, Promise<void>>;
}

// Only a safety net: installs and updates call invalidateSuggestionCache.
const SUGGESTION_CACHE_TTL_MS = 6 * 60 * 60_000;
// Memory goes back once suggestions and photo vectors have gone unused this long.
const SUGGESTION_IDLE_MS = 30 * 60_000;
const spaceKey = (space: VectorSpace) => `${space.modelVersion}|${space.textModelVersion}`;
const speciesStores = new Map<string, SpeciesStore>();
const regionCatalogCache = new Map<string, { at: number; entries: Promise<CandidateEntry[] | null> }>();
let packSpecies: { at: number; ids: Promise<string[]> } | null = null;

export function invalidateSuggestionCache(): void {
  regionCatalogCache.clear();
  speciesStores.clear();
  packSpecies = null;
}

// Drops expired region entries, and everything once suggestions have gone unused for a while.
setInterval(() => {
  const now = Date.now();
  let expired = false;
  for (const [key, hit] of regionCatalogCache) {
    if (now - hit.at < SUGGESTION_CACHE_TTL_MS) continue;
    regionCatalogCache.delete(key);
    expired = true;
  }
  if (expired) speciesStores.clear();
  if (now - lastSuggestionUse >= SUGGESTION_IDLE_MS) {
    invalidateSuggestionCache();
    userIndexes.clear();
    userSpeciesSets.clear();
    yourVectorCache.clear();
    yourVectorFloats = 0;
  }
}, 60_000).unref();

const toVec = (v: number[] | null): Float32Array | null => (v ? Float32Array.from(v) : null);

function storeFor(space: VectorSpace): SpeciesStore {
  let store = speciesStores.get(spaceKey(space));
  if (!store) {
    store = { entries: new Map(), loading: new Map() };
    speciesStores.set(spaceKey(space), store);
  }
  return store;
}

async function fetchSpeciesVectors(pool: Pool | PoolClient, space: VectorSpace, ids: string[]): Promise<Map<string, SpeciesVectors>> {
  const res = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    ref_embedding: number[] | null;
    gallery_embeddings: number[][] | null;
    text_embedding: number[] | null;
  }>(
    // Every gallery photo's vector, so a photo at a different angle than the main one still matches.
    `SELECT s.id AS species_id, s.common_name, s.scientific_name,
            sre.embedding AS ref_embedding,
            (SELECT array_agg(ge.embedding) FROM ${space.galleryTable} ge
               WHERE ge.species_id = s.id AND ge.model_version = $1) AS gallery_embeddings,
            ste.embedding AS text_embedding
       FROM species s
       LEFT JOIN ${space.referenceTable} sre ON sre.species_id = s.id AND sre.model_version = $1
       LEFT JOIN ${space.textTable} ste ON ste.species_id = s.id AND ste.model_version = $2
      WHERE s.id = ANY($3::uuid[])
        -- A species with no photo to show would render as a blank suggestion card.
        AND (s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL)`,
    [space.modelVersion, space.textModelVersion, ids],
  );
  return new Map(
    res.rows.map((r) => [
      r.species_id,
      {
        species_id: r.species_id,
        common_name: r.common_name,
        scientific_name: r.scientific_name,
        ref_embedding: toVec(r.ref_embedding),
        gallery_embeddings: r.gallery_embeddings?.map((g) => Float32Array.from(g)) ?? null,
        text_embedding: toVec(r.text_embedding),
      },
    ]),
  );
}

/** The shared store, with every id in `ids` loaded into it (each species read at most once). */
async function speciesVectors(pool: Pool | PoolClient, space: VectorSpace, ids: string[]): Promise<Map<string, SpeciesVectors | null>> {
  const store = storeFor(space);
  const toLoad = ids.filter((id) => !store.entries.has(id) && !store.loading.has(id));
  for (let i = 0; i < toLoad.length; i += 2000) {
    const batch = toLoad.slice(i, i + 2000);
    const load = fetchSpeciesVectors(pool, space, batch)
      .then((found) => {
        for (const id of batch) store.entries.set(id, found.get(id) ?? null);
      })
      .finally(() => {
        for (const id of batch) store.loading.delete(id);
      });
    for (const id of batch) store.loading.set(id, load);
  }
  const waits = new Set<Promise<void>>();
  for (const id of ids) {
    const load = store.loading.get(id);
    if (load) waits.add(load);
  }
  await Promise.all(waits);
  return store.entries;
}

/** Picks up one species' changed vectors or photo (an enrichment, a backfill) without dropping
 * every cached candidate set. */
export async function refreshSpeciesVectors(pool: Pool | PoolClient, speciesIds: string[]): Promise<void> {
  if (speciesIds.length === 0) return;
  for (const [key, store] of [...speciesStores]) {
    const cached = speciesIds.filter((id) => store.entries.has(id));
    if (cached.length === 0) continue;
    // A species that had no photo was left out of every set; it can only join by rebuilding them.
    if (cached.some((id) => store.entries.get(id) === null)) {
      invalidateSuggestionCache();
      return;
    }
    const space = [CLIP_SPACE, ID_SPACE].find((s) => spaceKey(s) === key);
    if (!space) continue;
    const fresh = await fetchSpeciesVectors(pool, space, cached);
    for (const id of cached) {
      const current = store.entries.get(id);
      const next = fresh.get(id);
      if (!current) continue;
      if (!next) {
        invalidateSuggestionCache(); // lost its photo: rebuild so it drops out
        return;
      }
      Object.assign(current, next); // in place, so every set holding it sees the change
    }
  }
}

// World and the continents have no checklist of their own, so their candidates are the
// checklists of the downloaded countries under them. Null when none is downloaded: the caller
// then matches as if no region was picked.
async function checklistRegionIds(pool: Pool | PoolClient, regionId: string): Promise<string[] | null> {
  const res = await pool.query<{ id: string; is_hub: boolean }>(
    `SELECT id, COALESCE(array_length(external_codes, 1), 0) = 0 AS is_hub FROM regions WHERE id = $1`,
    [regionId],
  );
  if (!res.rows[0]?.is_hub) return [regionId];
  const countries = await pool.query<{ id: string }>(
    `SELECT DISTINCT r.id FROM regions r
      WHERE (r.parent_id = $1 OR r.parent_id IN (SELECT id FROM regions WHERE parent_id = $1))
        AND EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = r.name)`,
    [regionId],
  );
  return countries.rows.length > 0 ? countries.rows.map((r) => r.id) : null;
}

function regionCandidateSet(pool: Pool | PoolClient, regionId: string, space: VectorSpace): Promise<CandidateEntry[] | null> {
  const key = `${spaceKey(space)}|region:${regionId}`;
  const hit = regionCatalogCache.get(key);
  if (hit && Date.now() - hit.at < SUGGESTION_CACHE_TTL_MS) return hit.entries;
  const entries = (async () => {
    const regionIds = await checklistRegionIds(pool, regionId);
    if (!regionIds) return null;
    const res = await pool.query<{
      species_id: string;
      common_name: string | null;
      scientific_name: string;
      ref_embedding: number[] | null;
      gallery_embeddings: number[][] | null;
      is_vagrant: boolean | null;
      local_tier: string | null;
      seasonality: number[] | null;
      text_embedding: number[] | null;
    }>(
      // DISTINCT ON: a species in more than one of the regions counts once, keeping a row
      // where it isn't a vagrant if there is one (a resident in either country is no rarity).
      `SELECT DISTINCT ON (s.id) s.id AS species_id, s.common_name, s.scientific_name,
              sre.embedding AS ref_embedding,
              (SELECT array_agg(ge.embedding) FROM ${space.galleryTable} ge
                 WHERE ge.species_id = s.id AND ge.model_version = $1) AS gallery_embeddings,
              rs.is_vagrant, rs.local_tier, rs.seasonality,
              ste.embedding AS text_embedding
         FROM region_species rs
         JOIN species s ON s.id = rs.species_id
         LEFT JOIN ${space.referenceTable} sre ON sre.species_id = s.id AND sre.model_version = $1
         LEFT JOIN ${space.textTable} ste ON ste.species_id = s.id AND ste.model_version = $2
        WHERE rs.region_id = ANY($3::uuid[])
          -- A species with no photo to show would render as a blank suggestion card.
          AND (s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL)
        ORDER BY s.id, rs.is_vagrant IS TRUE`,
      [space.modelVersion, space.textModelVersion, regionIds],
    );
    // A species already held for another region (World and its countries overlap) is shared,
    // not kept twice.
    const store = storeFor(space);
    const out: CandidateEntry[] = [];
    for (const r of res.rows) {
      let species = store.entries.get(r.species_id) ?? null;
      if (!species) {
        species = {
          species_id: r.species_id,
          common_name: r.common_name,
          scientific_name: r.scientific_name,
          ref_embedding: toVec(r.ref_embedding),
          gallery_embeddings: r.gallery_embeddings?.map((g) => Float32Array.from(g)) ?? null,
          text_embedding: toVec(r.text_embedding),
        };
        store.entries.set(r.species_id, species);
      }
      out.push({ species, is_vagrant: r.is_vagrant, local_tier: r.local_tier, seasonality: r.seasonality });
    }
    return out;
  })();
  regionCatalogCache.set(key, { at: Date.now(), entries });
  entries.catch(() => {
    if (regionCatalogCache.get(key)?.entries === entries) regionCatalogCache.delete(key);
  });
  return entries;
}

function packSpeciesIds(pool: Pool | PoolClient): Promise<string[]> {
  if (packSpecies && Date.now() - packSpecies.at < SUGGESTION_CACHE_TTL_MS) return packSpecies.ids;
  const ids = pool
    .query<{ species_id: string }>(`SELECT DISTINCT ps.species_id FROM pack_species ps JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`)
    .then((res) => res.rows.map((r) => r.species_id));
  const entry = { at: Date.now(), ids };
  packSpecies = entry;
  ids.catch(() => {
    if (packSpecies === entry) packSpecies = null;
  });
  return ids;
}

// No region picked: candidates are your own species plus every downloaded pack's.
async function libraryCandidateSet(pool: Pool | PoolClient, userId: string, space: VectorSpace): Promise<CandidateEntry[]> {
  const [yours, packs] = await Promise.all([userSpeciesIds(pool, userId), packSpeciesIds(pool)]);
  const ids = [...new Set([...yours, ...packs])].sort();
  const store = await speciesVectors(pool, space, ids);
  const out: CandidateEntry[] = [];
  for (const id of ids) {
    const species = store.get(id);
    if (species) out.push({ species, is_vagrant: null, local_tier: null, seasonality: null });
  }
  return out;
}

async function candidateEntries(pool: Pool | PoolClient, userId: string, regionId: string | null, space: VectorSpace): Promise<CandidateEntry[]> {
  const regional = regionId ? await regionCandidateSet(pool, regionId, space) : null;
  return regional ?? libraryCandidateSet(pool, userId, space);
}

/** Ranks candidate species for an already-computed embedding. With a `regionId`, candidates are
 * that region's checklist; without one, the user's species plus downloaded packs'. `takenAt`
 * lets off-season species rank below in-season look-alikes. */
export async function rankSpeciesByEmbedding(
  pool: Pool | PoolClient,
  userId: string,
  embedding: ArrayLike<number>,
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  space: VectorSpace = CLIP_SPACE,
): Promise<SpeciesSuggestion[]> {
  return rankSpeciesByEmbeddings(pool, userId, [embedding], regionId, limit, takenAt, space);
}

/** rankSpeciesByEmbedding against several embeddings (e.g. video frames): each species scores by
 * its best single match, not an average, so blurry frames don't drag it down. `embeddings` must
 * come from the model `space` describes. */
export async function rankSpeciesByEmbeddings(
  pool: Pool | PoolClient,
  userId: string,
  embeddings: ArrayLike<number>[],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  space: VectorSpace = CLIP_SPACE,
): Promise<SpeciesSuggestion[]> {
  if (embeddings.length === 0) return [];
  lastSuggestionUse = Date.now();
  const [entries, yours] = await Promise.all([candidateEntries(pool, userId, regionId, space), yourVectorsBySpecies(pool, userId, space)]);

  const scored: SpeciesSuggestion[] = [];
  for (const entry of entries) {
    const sp = entry.species;
    const targets = matchTargets({ your_embeddings: yours.get(sp.species_id) ?? null, ref_embedding: sp.ref_embedding, gallery_embeddings: sp.gallery_embeddings });
    if (targets.length === 0) continue;
    const adjustment = occurrenceAdjustment({ isVagrant: entry.is_vagrant, localTier: entry.local_tier, seasonality: entry.seasonality }, takenAt);
    let bestScore = -Infinity;
    let bestFrame = embeddings[0];
    let best = targets[0];
    for (const frameEmbedding of embeddings) {
      for (const target of targets) {
        const score = cosineSimilarity(frameEmbedding, target.embedding) * target.factor;
        if (score > bestScore) {
          bestScore = score;
          bestFrame = frameEmbedding;
          best = target;
        }
      }
    }
    scored.push({
      id: sp.species_id,
      common_name: sp.common_name,
      scientific_name: sp.scientific_name,
      score: blendWithText(bestScore * adjustment, bestFrame, sp.text_embedding, space.textWeight),
      source: best.source,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  markConfidence(scored, space);
  assignDisplayPercents(scored, space);
  return trimLowRelevance(scored, limit, space);
}

// Suggestions use the identification model once it's downloaded and its vectors are installed,
// CLIP otherwise. "Not yet" is cached briefly so the switch happens soon; "yes" is cached for good.
let idVectorsInstalled = false;
let idVectorsCheckedAt = 0;
const ID_VECTORS_RECHECK_MS = 60_000;

async function idModelReady(pool: Pool | PoolClient): Promise<boolean> {
  if (!idModel.isDownloaded() || idModel.isStuck()) return false;
  if (idVectorsInstalled) return true;
  if (Date.now() - idVectorsCheckedAt < ID_VECTORS_RECHECK_MS) return false;
  idVectorsCheckedAt = Date.now();
  const res = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM id_model_text_embeddings WHERE model_version = $1) AS ok`,
    [ID_MODEL_VERSION],
  );
  idVectorsInstalled = res.rows[0].ok;
  return idVectorsInstalled;
}

/** Which model suggestions run on right now, for Settings. */
export async function activeSuggestionModel(pool: Pool): Promise<"identification" | "general" | null> {
  if (await idModelReady(pool)) return "identification";
  return isModelDownloaded() ? "general" : null;
}

/** For tests and for the vector installer, which knows the answer just changed. */
export function resetIdModelReadiness(): void {
  idVectorsInstalled = false;
  idVectorsCheckedAt = 0;
}

/** The vector a suggestion for this install is ranked from, and the space it ranks in. */
export async function suggestionVectorKind(pool: Pool | PoolClient): Promise<{ kind: "id-crop" | "clip-crop"; space: VectorSpace } | null> {
  if (await idModelReady(pool)) return { kind: "id-crop", space: ID_SPACE };
  return isModelDownloaded() ? { kind: "clip-crop", space: CLIP_SPACE } : null;
}

/** Suggests species for one photo with the identification model when ready, else CLIP. An
 * identification-model failure falls back to CLIP. */
export async function suggestSpecies(
  pool: Pool,
  userId: string,
  buffer: Buffer,
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  opts: { priority?: Priority; key?: string } = {},
): Promise<SpeciesSuggestion[]> {
  return suggestSpeciesForFrames(pool, userId, [buffer], regionId, limit, takenAt, opts);
}

/** suggestSpecies for several frames of one clip (see rankSpeciesByEmbeddings). */
export async function suggestSpeciesForFrames(
  pool: Pool,
  userId: string,
  frames: Buffer[],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  opts: { priority?: Priority; key?: string } = {},
): Promise<SpeciesSuggestion[]> {
  if (frames.length === 0) return [];
  const priority = opts.priority ?? "interactive";
  const key = frames.length === 1 ? opts.key : undefined;
  // Per frame, so a later storeIdCaptureEmbedding of the same photo reuses the vector.
  if (await idModelReady(pool)) {
    try {
      const embeddings = (await Promise.all(frames.map((frame) => suggestionVectors(frame, "id-crop", { key, priority })))).flat();
      return await rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, ID_SPACE);
    } catch {
      // fall through to CLIP
    }
  }
  const embeddings = (await Promise.all(frames.map((frame) => suggestionVectors(frame, "clip-crop", { key, priority })))).flat();
  return rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, CLIP_SPACE);
}

/** Preloads models and the candidate set so the first photo checked doesn't pay for it. Best effort. */
export async function warmSuggestions(pool: Pool, userId: string, regionId: string | null, text: TextModelSpec | null): Promise<void> {
  const active = await suggestionVectorKind(pool);
  const models = [clipModel, idModel].filter((m) => m.isDownloaded()).map((m) => m.target(false));
  await Promise.all([
    models.length > 0 ? warmModels({ models, detector: true, text }) : Promise.resolve(),
    active ? rankSpeciesByEmbeddings(pool, userId, [new Float32Array(768)], regionId, 1, null, active.space).catch(() => {}) : Promise.resolve(),
    isModelDownloaded() ? findNearDuplicate(pool, userId, new Float32Array(768), 2).catch(() => {}) : Promise.resolve(),
  ]);
}
