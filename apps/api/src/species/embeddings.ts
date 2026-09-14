// Species auto-suggest — local-first nearest-neighbor search over pretrained image embeddings
// (see ~/.claude/plans/vast-prancing-turing.md, Phases 1-2: on by default, nothing ever leaves
// the device). No pgvector: the desktop app's embedded Postgres ships no extensions, so
// candidate vectors are plain `real[]` columns (capture_embeddings/species_reference_embeddings,
// migration 058) and ranking is done here in plain JS — fine at personal-library scale (at most
// a few thousand vectors, brute-force cosine similarity is sub-100ms with no native dependency).
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR, EMBEDDING_MODEL_URL, EMBEDDING_MODEL_VERSION } from "../config.js";

// Opt-in, offload-able download — same shape as the offline basemap (settings/routes.ts's
// /settings/map/* routes). Not bundled at build time on any platform: this directory (and
// textEmbedding.ts's own clip-text-cache subdirectory within it) is deleted wholesale on
// offload, so nothing here can assume it's the only thing writing under MODEL_DIR.
export const MODEL_DIR = path.join(APP_DATA_DIR, "models");
const MODEL_PATH = path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`);

/** Whether the vision half of the model has already been downloaded — cheap, sync, safe to call
 * from a status endpoint on every poll. */
export function isModelDownloaded(): boolean {
  return existsSync(MODEL_PATH);
}

/** Deletes the whole model directory (vision .onnx file + textEmbedding.ts's cached text
 * encoder) to reclaim disk space. Safe to call even if nothing was ever downloaded. */
export function offloadModel(): void {
  rmSync(MODEL_DIR, { recursive: true, force: true });
  sessionPromise = null; // an in-memory session pointing at a now-deleted file must not be reused
}

const INPUT_SIZE = 224;
// CLIP's own published preprocessing constants — every CLIP-family vision encoder (including
// this quantized export) was trained expecting pixels normalized against exactly these, not a
// generic ImageNet mean/std.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

let sessionPromise: Promise<ort.InferenceSession> | null = null;

/** Downloads the vision model into MODEL_PATH, streaming to disk (not buffered in memory — this
 * file is ~307MB) with an atomic rename on completion so a killed-mid-download file never looks
 * "ready". `onProgress` (optional) mirrors the map download job's own byte-count reporting so
 * the Settings UI can show a real progress bar instead of a spinner. */
export async function downloadModel(onProgress?: (downloadedBytes: number, totalBytes: number | null) => void): Promise<void> {
  mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetch(EMBEDDING_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the embedding model (${res.status})`);
  const contentLength = res.headers.get("content-length");
  const totalBytes = contentLength ? Number(contentLength) : null;
  const tmpPath = `${MODEL_PATH}.download`;
  const { createWriteStream, renameSync } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const { finished } = await import("node:stream/promises");
  const out = createWriteStream(tmpPath);
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  let downloadedBytes = 0;
  nodeStream.on("data", (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    onProgress?.(downloadedBytes, totalBytes);
  });
  nodeStream.pipe(out);
  await finished(out);
  renameSync(tmpPath, MODEL_PATH); // atomic swap — a killed-mid-download file never looks "ready"
}

// Deliberately does NOT auto-download — same opt-in contract as the offline basemap: a caller
// only ever gets this model by way of the explicit Settings > Offline Data download (or the
// desktop app's own first-run map/model prompt), never as a surprise multi-hundred-MB fetch
// triggered by an ordinary upload/search request. Every call site below already treats a thrown
// error here as "feature unavailable, degrade gracefully," not a hard failure.
async function resolveModelPath(): Promise<string> {
  if (!existsSync(MODEL_PATH)) throw new Error("The species-matching model hasn't been downloaded (Settings > Offline Data)");
  return MODEL_PATH;
}

// Lazily downloaded and loaded on first real use (first backfill tick or first suggestion
// request), not at server startup — most self-hosted deployments never touch this path at all
// (Docker/NAS mode has no photo-picking UI), so there's no reason to pay the download/load cost
// there. Cached as a shared promise so concurrent callers await the same in-flight load rather
// than racing to download/init twice.
async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const modelPath = await resolveModelPath();
      return ort.InferenceSession.create(modelPath);
    })().catch((err) => {
      sessionPromise = null; // let the next caller retry instead of caching a permanent failure
      throw err;
    });
  }
  return sessionPromise;
}

// Resize/crop to CLIP's expected 224x224 and normalize into NCHW float32 — mirrors how
// uploads/image.ts already uses sharp for derivative generation, just producing a tensor instead
// of a webp file.
async function preprocessImage(buffer: Buffer): Promise<Float32Array> {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floats = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      // HWC -> CHW: channel c's plane starts at c * pixelCount
      floats[c * pixelCount + i] = (value - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return floats;
}

export function l2Normalize(vec: Float32Array): number[] {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares) || 1;
  return Array.from(vec, (v) => v / norm);
}

const INFERENCE_TIMEOUT_MS = 20_000;

/** Computes an L2-normalized embedding for one image. Never touches the network beyond the
 * one-time model download above — everything after that is local CPU inference. Guarded by a
 * hard timeout: a native ONNX/sharp binding hanging on one pathological image must never hang
 * the caller (an HTTP request, or a backfill loop) forever. */
export async function computeEmbedding(buffer: Buffer): Promise<number[]> {
  const work = (async () => {
    const session = await getSession();
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const tensor = new ort.Tensor("float32", await preprocessImage(buffer), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run({ [inputName]: tensor });
    return l2Normalize(results[outputName].data as Float32Array);
  })();
  // Silences an unhandled rejection if `work` loses the race below and fails afterward (the
  // pathological-hang case this timeout exists for) — Promise.race still separately sees
  // `work`'s real outcome via its own subscription, this is just an extra listener.
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<number[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error("embedding inference timed out")), INFERENCE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    // Without this, every ordinary (fast) call leaves this timer running for the rest of its
    // 20s — when it eventually fires, it rejects a promise nothing is listening to anymore
    // (Promise.race already settled), which is an unhandled rejection on every single call.
    clearTimeout(timer!);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // both vectors are already L2-normalized, so the dot product IS the cosine similarity
}

// This model's embeddings don't spread cosine similarity across the full [-1, 1] range the way
// the raw number suggests — two completely unrelated species' photos (different animal,
// different setting) still routinely land in the 0.55-0.75 band just from sharing generic
// "wildlife photo" visual structure, while genuine same-species pairs average ~0.84 (measured
// directly against this app's own capture_embeddings — sampled diff-species pairs: avg 0.666,
// p90 0.729, p99 0.781; same-species pairs: avg 0.843). Below this without any floor, every
// suggestion slot got filled regardless of how weak the match was, which is mostly harmless for
// a single still photo but compounds for video: taking the MAX similarity across several sampled
// frames (rankSpeciesByEmbeddings below) gives each unrelated candidate several extra rolls to
// land in that noise band, so a video reliably surfaced 1-2 completely unrelated "matches"
// alongside the real one. Chosen comfortably above the measured noise ceiling (p99 0.781) and
// well below genuine same-species similarity (0.843), so it cuts noise without being so strict
// it risks dropping a real match that came from an imperfect angle/lighting.
const MIN_SUGGESTION_SCORE = 0.78;

export async function storeCaptureEmbedding(client: Pool | PoolClient, captureId: string, embedding: number[]): Promise<void> {
  await client.query(
    `INSERT INTO capture_embeddings (capture_id, embedding, model_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (capture_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
    [captureId, embedding, EMBEDDING_MODEL_VERSION],
  );
}

// Field names deliberately match SpeciesResult (species/routes.ts's /species search response)
// exactly — id/common_name/scientific_name, not speciesId/commonName/scientificName — since the
// frontend's SpeciesPicker/PhotoImportRows treat a suggestion as just another SpeciesResult (see
// SuggestedSpecies in SpeciesPicker.tsx) and select it the same way regardless of where it came
// from.
export interface SpeciesSuggestion {
  id: string;
  common_name: string | null;
  scientific_name: string;
  score: number;
  source: "your_photos" | "reference_photo" | "keyword_tag";
}

/** Ranks candidate species for an already-computed embedding by similarity. Split out from
 * suggestSpecies below so a caller that has ALSO already computed this same photo's embedding
 * for another reason (see uploads/routes.ts's /uploads/inspect, which needs one anyway for its
 * own near-duplicate check) can rank suggestions from it directly, instead of paying for a
 * second, redundant CPU-bound inference pass on the identical image. When `regionId` is given
 * (the user picked a country/region in the import UI), candidates are narrowed to that region's
 * own checklist (region_species) — the real structural narrowing region browsing elsewhere in
 * the app already relies on, made possible here without any point-in-region geometry because
 * the region came from an explicit user choice rather than a photo's lat/lon. Without a
 * regionId, falls back to a looser narrowing: species the user has already photographed, plus
 * species belonging to any pack they've downloaded. */
export async function rankSpeciesByEmbedding(
  pool: Pool,
  userId: string,
  embedding: number[],
  regionId: string | null,
  limit = 5,
): Promise<SpeciesSuggestion[]> {
  const candidateCte = regionId
    ? `SELECT species_id FROM region_species WHERE region_id = $3`
    : `SELECT species_id FROM user_species WHERE user_id = $1
       UNION
       SELECT ps.species_id FROM pack_species ps
       JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`;

  const candidatesRes = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    embedding: number[] | null;
    ref_embedding: number[] | null;
  }>(
    `WITH candidate_species AS (${candidateCte})
     SELECT
       s.id AS species_id,
       s.common_name,
       s.scientific_name,
       -- The user's own best-matching capture of this species, if any (only their own captures —
       -- another user's photos are never compared against, even on a shared server deployment).
       (SELECT ce.embedding FROM capture_embeddings ce
          JOIN captures c ON c.id = ce.capture_id
          WHERE c.species_id = s.id AND c.user_id = $1 AND ce.model_version = $2
          ORDER BY ce.computed_at DESC LIMIT 1) AS embedding,
       sre.embedding AS ref_embedding
     FROM candidate_species cs
     JOIN species s ON s.id = cs.species_id
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $2`,
    regionId ? [userId, EMBEDDING_MODEL_VERSION, regionId] : [userId, EMBEDDING_MODEL_VERSION],
  );

  const scored: SpeciesSuggestion[] = [];
  for (const row of candidatesRes.rows) {
    if (row.embedding) {
      scored.push({
        id: row.species_id,
        common_name: row.common_name,
        scientific_name: row.scientific_name,
        score: cosineSimilarity(embedding, row.embedding),
        source: "your_photos",
      });
    } else if (row.ref_embedding) {
      scored.push({
        id: row.species_id,
        common_name: row.common_name,
        scientific_name: row.scientific_name,
        score: cosineSimilarity(embedding, row.ref_embedding),
        source: "reference_photo",
      });
    }
  }

  const confident = scored.filter((s) => s.score >= MIN_SUGGESTION_SCORE);
  confident.sort((a, b) => b.score - a.score);
  return confident.slice(0, limit);
}

/** Same candidate scoring as rankSpeciesByEmbedding, but against SEVERAL embeddings at once
 * (e.g. multiple frames sampled from one video clip) — a species scores by whichever single
 * embedding matched it best, not an average across all of them. Averaging would dilute a real
 * match: the animal is very unlikely to be clearly visible, well-framed, and in-focus in EVERY
 * sampled frame of a clip (some frames are mid-motion blur, some catch the subject leaving
 * frame, some are mostly background) the way a single deliberately-taken photo usually is, so
 * the frame that best captures it should decide the match, not get dragged down by the rest.
 * One shared candidate-species query (not one per embedding) keeps this to the same DB cost as
 * the single-embedding version regardless of how many frames were sampled. */
export async function rankSpeciesByEmbeddings(
  pool: Pool,
  userId: string,
  embeddings: number[][],
  regionId: string | null,
  limit = 5,
): Promise<SpeciesSuggestion[]> {
  if (embeddings.length === 0) return [];
  const candidateCte = regionId
    ? `SELECT species_id FROM region_species WHERE region_id = $3`
    : `SELECT species_id FROM user_species WHERE user_id = $1
       UNION
       SELECT ps.species_id FROM pack_species ps
       JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`;

  const candidatesRes = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    embedding: number[] | null;
    ref_embedding: number[] | null;
  }>(
    `WITH candidate_species AS (${candidateCte})
     SELECT
       s.id AS species_id,
       s.common_name,
       s.scientific_name,
       (SELECT ce.embedding FROM capture_embeddings ce
          JOIN captures c ON c.id = ce.capture_id
          WHERE c.species_id = s.id AND c.user_id = $1 AND ce.model_version = $2
          ORDER BY ce.computed_at DESC LIMIT 1) AS embedding,
       sre.embedding AS ref_embedding
     FROM candidate_species cs
     JOIN species s ON s.id = cs.species_id
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $2`,
    regionId ? [userId, EMBEDDING_MODEL_VERSION, regionId] : [userId, EMBEDDING_MODEL_VERSION],
  );

  const scored: SpeciesSuggestion[] = [];
  for (const row of candidatesRes.rows) {
    const target = row.embedding ?? row.ref_embedding;
    if (!target) continue;
    const source: SpeciesSuggestion["source"] = row.embedding ? "your_photos" : "reference_photo";
    let bestScore = -Infinity;
    for (const embedding of embeddings) bestScore = Math.max(bestScore, cosineSimilarity(embedding, target));
    scored.push({ id: row.species_id, common_name: row.common_name, scientific_name: row.scientific_name, score: bestScore, source });
  }

  const confident = scored.filter((s) => s.score >= MIN_SUGGESTION_SCORE);
  confident.sort((a, b) => b.score - a.score);
  return confident.slice(0, limit);
}

/** Thin wrapper for callers that haven't already computed this photo's embedding for some
 * other reason — computes it fresh, then ranks the same way rankSpeciesByEmbedding does. */
export async function suggestSpecies(
  pool: Pool,
  userId: string,
  buffer: Buffer,
  regionId: string | null,
  limit = 5,
): Promise<SpeciesSuggestion[]> {
  const embedding = await computeEmbedding(buffer);
  return rankSpeciesByEmbedding(pool, userId, embedding, regionId, limit);
}
