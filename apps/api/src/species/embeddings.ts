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
import { cropToSubject } from "./detectAndCrop.js";

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
  cancelIdleUnload(); // nothing left to unload once this runs
  sessionPromise = null; // an in-memory session pointing at a now-deleted file must not be reused
}

const INPUT_SIZE = 224;
// CLIP's own published preprocessing constants — every CLIP-family vision encoder (including
// this quantized export) was trained expecting pixels normalized against exactly these, not a
// generic ImageNet mean/std.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

let sessionPromise: Promise<ort.InferenceSession> | null = null;

// Loading this session costs a real, user-visible amount of time (reading ~307MB off disk and
// initializing the ONNX runtime), which is why it's kept warm across requests rather than
// reloaded every call — but "warm forever, even after hours of total inactivity" wastes real
// memory on a self-hosted server that isn't always actively matching photos (a Docker/NAS
// deployment can sit idle for days between imports). Unloading after a period of no use gets
// both: fast while actually in use, small the rest of the time. `activeInferences` guards
// against unloading out from under a call that's still mid-`session.run()` — the timer only
// ever arms once nothing is actively using the session, not on a fixed schedule.
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
let activeInferences = 0;
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleUnload(): void {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function armIdleUnload(): void {
  cancelIdleUnload();
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    const promise = sessionPromise;
    sessionPromise = null;
    // Best-effort: if the session never actually finished loading (a prior download/init
    // failure), there's nothing native to release — getSession()'s own .catch already cleared
    // sessionPromise in that case, so this is mostly a no-op guard, not the common path.
    promise?.then((session) => session.release()).catch(() => {});
  }, IDLE_UNLOAD_MS);
  idleUnloadTimer.unref?.();
}

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
  cancelIdleUnload(); // never unload while a caller is about to (or currently) using it
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
  // Counts this call as "active" for the session's whole real lifetime — including the rare
  // case where `work` loses the race below and keeps running in the background after a
  // timeout. Tied to `work` itself finishing, not to the race settling, so an idle-unload can
  // never fire while a `session.run()` call is genuinely still in flight underneath it.
  activeInferences++;
  const work = (async () => {
    const session = await getSession();
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const tensor = new ort.Tensor("float32", await preprocessImage(buffer), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await session.run({ [inputName]: tensor });
    return l2Normalize(results[outputName].data as Float32Array);
  })();
  work.finally(() => {
    activeInferences--;
    if (activeInferences === 0) armIdleUnload();
  });
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

/** Same as computeEmbedding, but crops to the detected animal first (detectAndCrop.ts) — use
 * this specifically for SUGGESTION-time embeddings, never for the reference/gallery database or
 * for near-duplicate detection. Real evaluation showed cropping the query photo alone (leaving
 * every stored reference/gallery embedding as-is) captured the whole measured benefit; cropping
 * is deliberately NOT applied to near-duplicate detection's own embedding, since that check
 * compares against OTHER un-cropped capture_embeddings rows and needs the same preprocessing on
 * both sides to mean anything. */
export async function computeSuggestionEmbedding(buffer: Buffer): Promise<number[]> {
  return computeEmbedding(await cropToSubject(buffer));
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
// p90 0.729, p99 0.781; same-species pairs: avg 0.843). A flat score floor used to live here
// (MIN_SUGGESTION_SCORE, 0.78) to cut that noise — replaced by CONFIDENCE_FLOOR/CONFIDENCE_MARGIN
// below once text-blending changed the score's scale entirely (see that comment for why a fixed
// absolute cutoff doesn't transfer, and why a margin-over-runner-up rule replaced it).

// Soft demotion factors, not exclusions — a genuinely correct vagrant/off-season ID should
// still win when its VISUAL match is clearly the best one; this only breaks near-ties in favor
// of the species that's actually plausible to encounter, instead of letting raw cosine
// similarity alone decide (which has no idea a Great Blue Heron photo scoring 0.80 against
// Arctic Loon's reference and 0.82 against its own species should obviously rank the heron
// first — both scores land in the same visual-similarity noise band, so occurrence likelihood
// is what should break that tie, not coin-flip embedding noise). Same tier vocabulary as
// region_species.local_tier ("photographability," not conservation status — see this app's own
// rarity-tier philosophy) and region_species.is_vagrant (migration 024).
const VAGRANT_SCORE_FACTOR = 0.88;
const TIER_SCORE_FACTOR: Partial<Record<string, number>> = {
  legendary: 0.94,
  epic: 0.96,
  rare: 0.98,
};
// Below this fraction of a species' peak-month occurrence, a sighting in the photo's actual
// month is unusual enough to weigh against it too — e.g. a winter-only species suggested for a
// midsummer photo. Fractional (not an absolute count) since seasonality is stored as relative
// monthly shares, not raw record counts, and species vary hugely in total record volume.
const OFF_SEASON_RATIO = 0.05;
const OFF_SEASON_SCORE_FACTOR = 0.94;

// "your_photos" candidates (matched against ONE of your own past captures) measurably run hot
// relative to "reference_photo" candidates (matched against curated reference/gallery images),
// independent of actual subject similarity — confirmed live: a real Cedar Waxwing photo scored
// higher against a Red Fox, a Red Squirrel, and a Fuzzy-Horned Bumble Bee from the same user's
// library (0.73-0.76) than against Cedar Waxwing's OWN reference photos (0.61-0.67) or even
// Bohemian Waxwing — its closest relative (0.71). The likely cause: every photo from one
// person's library shares the same camera sensor, color/export pipeline, and compression
// artifacts, which a whole-image embedding partially keys on as "looks like this photographer's
// work" independent of species — a bias reference photos (pulled from many different sources)
// never share. This discount is calibrated to flip that specific case (a real bird reference
// only needs to beat a same-library non-bird by a few points) while barely touching genuine
// repeat sightings of the same species, which score high enough (~0.84 average) to clear
// MIN_SUGGESTION_SCORE even after the discount.
const YOUR_PHOTOS_SCORE_FACTOR = 0.94;

// Zero-shot text-prompt signal (species_text_embeddings, migration 102), blended into the final
// score alongside the image-image signal above — a completely independent source of evidence
// (CLIP's TEXT encoder comparing the query photo directly against "a photo of a {species}",
// unaffected by the query's own background/lighting/composition) that measurably roughly
// doubled honest leave-one-out top-1 accuracy in real testing against the BC checklist (14/48 ->
// 30/48 once combined with cropping — see this file's own crop comment). 0.7 was the weight that
// won a real sweep (0.5/0.6/0.7/0.8) on that same data, not a guess.
const TEXT_BLEND_WEIGHT = 0.7;

// Replaces the old flat MIN_SUGGESTION_SCORE cutoff — blending in the text signal changes the
// score's scale entirely (a genuine top-1 match can now land anywhere from ~0.4 to ~0.9
// depending on the photo and how confidently CLIP's text encoder recognizes that species' name),
// so a fixed absolute floor calibrated against the OLD pure-image scale doesn't transfer.
// Real leave-one-out data (N=50: 32 correct top-1s, 18 incorrect) showed the winning-margin over
// the #2 candidate is what actually separates right from wrong, not the winner's raw score:
// every incorrect top-1 in that data won by < 0.0232, while correct top-1s had a much wider,
// higher-margin distribution (median 0.028). CONFIDENCE_MARGIN sits just above the observed
// incorrect-case ceiling — zero false positives in that data, at the cost of some genuinely
// correct matches (~40%) not clearing the bar and showing as a lower-confidence guess instead of
// a confident pick, which is the right failure direction for a suggestion feature (never
// falsely certain). CONFIDENCE_FLOOR is a basic sanity screen, not the real discriminator (both
// correct and incorrect top-1s span roughly the same absolute range) — it just guards against a
// degenerate case with no real signal at all. Both are launch values from a small (N=50) sample,
// not permanent constants — worth re-deriving once real production usage data accumulates.
const CONFIDENCE_FLOOR = 0.4;
const CONFIDENCE_MARGIN = 0.025;

/** Blends the image-image score with this candidate's zero-shot text-prompt score, when one's
 * available (species_text_embeddings hasn't necessarily been backfilled for every species/model
 * version yet) — falls back to the pure image score otherwise, same graceful-degradation shape
 * every other optional signal in this file already uses. */
function blendWithText(imageScore: number, embedding: number[], textEmbedding: number[] | null): number {
  if (!textEmbedding) return imageScore;
  const textScore = cosineSimilarity(embedding, textEmbedding);
  return (1 - TEXT_BLEND_WEIGHT) * imageScore + TEXT_BLEND_WEIGHT * textScore;
}

/** Marks the single top-ranked candidate (only) as `confident` when it clears BOTH the floor and
 * the margin-over-runner-up bar — see CONFIDENCE_MARGIN's own comment for why a margin, not an
 * absolute cutoff, is what the blended score actually needs. Mutates in place; expects `scored`
 * already sorted descending by score. */
function markConfidence(scored: SpeciesSuggestion[]): void {
  if (scored.length === 0) return;
  const runnerUpScore = scored[1]?.score ?? -Infinity;
  scored[0].confident = scored[0].score >= CONFIDENCE_FLOOR && scored[0].score - runnerUpScore >= CONFIDENCE_MARGIN;
}

// A margin of this size (top pick vs. runner-up) is roughly as decisive as this data ever gets
// — the real leave-one-out calibration's correct-top-1 margins topped out around 0.053 (see
// CONFIDENCE_MARGIN's own comment). Used only to scale matchPercent below, not to gate anything.
const DISPLAY_MARGIN_SCALE = 0.05;
const DISPLAY_BASE_PERCENT = 50;
const DISPLAY_TOP_PERCENT = 99;
// Below this, a trailing alternative isn't a real second guess any more — it's just whatever
// happened to be 4th or 5th by raw score, often trailing the top pick by a wide margin. Once one
// item in the (already sorted, monotonically non-increasing) list falls below this, everything
// after it does too, so trimLowRelevance below can stop at the first one rather than checking
// each individually.
const MIN_DISPLAY_PERCENT = 15;

/** Cuts the ranked, percent-assigned list off at the first item below MIN_DISPLAY_PERCENT (the
 * top pick, index 0, is always kept regardless) — showing a 2% "alternative" next to a 50%+ top
 * pick isn't a real choice, just padding the list out to `limit` for its own sake. Expects
 * `scored` already sorted descending with assignDisplayPercents already run. */
function trimLowRelevance(scored: SpeciesSuggestion[], limit: number): SpeciesSuggestion[] {
  let cutoff = scored.length;
  for (let i = 1; i < scored.length; i++) {
    if ((scored[i].matchPercent ?? 0) < MIN_DISPLAY_PERCENT) {
      cutoff = i;
      break;
    }
  }
  return scored.slice(0, Math.min(limit, cutoff));
}

/** Sets a 0-100 `matchPercent` on every item, meant to be shown to the user instead of the raw
 * blended `score` — that raw score isn't a meaningful "percent likelihood" any more (blending in
 * the zero-shot text signal put it on CLIP's text-image similarity scale, where even a genuinely
 * correct match often lands around 0.3-0.5, not the 0.7-0.9 range image-image similarity alone
 * used to produce). Rather than cosmetically stretching that compressed, weakly-discriminating
 * raw number across 0-100 (which real calibration data showed does NOT reliably separate correct
 * from incorrect answers — see CONFIDENCE_MARGIN's comment: right and wrong top-1s span roughly
 * the same absolute range), this instead cascades down the sorted list using each item's margin
 * over the next one — the exact signal that DOES reliably separate them, and the same one
 * `confident` above is gated on. The result: a decisive top pick reads high (confident ~75-99%,
 * matching markConfidence's own threshold), a genuine toss-up reads closer to 50%, and every
 * later alternative reads lower still by however much it actually trails the one before it. This
 * is a display-only computation — matchPercent is never used for ranking or confidence, only for
 * what the user sees. Expects `scored` already sorted descending by score. */
function assignDisplayPercents(scored: SpeciesSuggestion[]): void {
  for (let i = 0; i < scored.length; i++) {
    if (i === 0) {
      // No runner-up at all means nothing contradicts this pick — treat that as maximally
      // decisive rather than undefined, same reasoning markConfidence's own runnerUpScore
      // fallback uses.
      const margin = scored.length > 1 ? scored[0].score - scored[1].score : DISPLAY_MARGIN_SCALE;
      const t = Math.min(1, Math.max(0, margin / DISPLAY_MARGIN_SCALE));
      scored[0].matchPercent = Math.round(DISPLAY_BASE_PERCENT + t * (DISPLAY_TOP_PERCENT - DISPLAY_BASE_PERCENT));
      continue;
    }
    const margin = scored[i - 1].score - scored[i].score;
    const t = Math.min(1, Math.max(0, margin / DISPLAY_MARGIN_SCALE));
    // Even a near-zero gap still reads as a step down (5 points), so two candidates never
    // display as visually tied — a bigger gap (up to the full 0.05 margin scale) drops up to 45.
    const decrement = 5 + t * 40;
    scored[i].matchPercent = Math.max(2, scored[i - 1].matchPercent! - Math.round(decrement));
  }
}

export interface OccurrenceContext {
  isVagrant: boolean | null;
  localTier: string | null;
  seasonality: number[] | null;
}

// Combines into one multiplier rather than several independent filters — a legendary-tier
// vagrant photographed wildly out of season stacks multiple weak signals into one clearly
// wrong candidate, while a common species with no signals at all (the overwhelmingly typical
// case) stays completely untouched at 1.0.
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
  /** Set only on the single top-ranked candidate — see markConfidence's own comment. Absent
   * (not false) on a keyword_tag suggestion, which is a certain exact match by construction, not
   * something this margin-based rule ever needs to evaluate. */
  confident?: boolean;
  /** 0-100 — show this, not a raw `score * 100`, to the user. See assignDisplayPercents' own
   * comment for why. Absent on a keyword_tag suggestion for the same reason `confident` is. */
  matchPercent?: number;
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
 * species belonging to any pack they've downloaded. `takenAt` (the photo's own EXIF date, when
 * known) lets occurrenceAdjustment weigh candidates by whether they're actually plausible for
 * that region right now — a vagrant or wildly off-season species shouldn't outrank a common,
 * in-season look-alike just because two embeddings landed at a similar cosine distance. */
export async function rankSpeciesByEmbedding(
  pool: Pool,
  userId: string,
  embedding: number[],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
): Promise<SpeciesSuggestion[]> {
  const candidateCte = regionId
    ? `SELECT species_id, is_vagrant, local_tier, seasonality FROM region_species WHERE region_id = $3`
    : `SELECT species_id, NULL::boolean AS is_vagrant, NULL::text AS local_tier, NULL::numeric[] AS seasonality
       FROM user_species WHERE user_id = $1
       UNION
       SELECT ps.species_id, NULL, NULL, NULL FROM pack_species ps
       JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`;

  const candidatesRes = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    embedding: number[] | null;
    ref_embedding: number[] | null;
    gallery_embeddings: number[][] | null;
    is_vagrant: boolean | null;
    local_tier: string | null;
    seasonality: number[] | null;
    text_embedding: number[] | null;
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
       sre.embedding AS ref_embedding,
       -- Every gallery photo's own embedding (migration 101). Matching against the best of
       -- SEVERAL reference poses, not just the one main photo, catches a real photo taken at a
       -- different angle than that single reference image (see this file's own module comment).
       (SELECT array_agg(ge.embedding) FROM species_reference_gallery_embeddings ge
          WHERE ge.species_id = s.id AND ge.model_version = $2) AS gallery_embeddings,
       cs.is_vagrant,
       cs.local_tier,
       cs.seasonality,
       ste.embedding AS text_embedding
     FROM candidate_species cs
     JOIN species s ON s.id = cs.species_id
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $2
     LEFT JOIN species_text_embeddings ste ON ste.species_id = s.id
     -- Every suggestion card fetches /species/:id/reference-photo/thumb regardless of source
     -- (your_photos included — see SuggestionCard.tsx), so a species with neither a cached
     -- local file NOR a live remote URL to recover one from (reference_photo) always renders
     -- as a blank placeholder card. Excluded here rather than left to the frontend to hide,
     -- so a real 4th/5th candidate can take that slot instead of the list just running short.
     WHERE s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL`,
    regionId ? [userId, EMBEDDING_MODEL_VERSION, regionId] : [userId, EMBEDDING_MODEL_VERSION],
  );

  const scored: SpeciesSuggestion[] = [];
  for (const row of candidatesRes.rows) {
    const adjustment = occurrenceAdjustment({ isVagrant: row.is_vagrant, localTier: row.local_tier, seasonality: row.seasonality }, takenAt);
    if (row.embedding) {
      const imageScore = cosineSimilarity(embedding, row.embedding) * adjustment * YOUR_PHOTOS_SCORE_FACTOR;
      scored.push({
        id: row.species_id,
        common_name: row.common_name,
        scientific_name: row.scientific_name,
        score: blendWithText(imageScore, embedding, row.text_embedding),
        source: "your_photos",
      });
      continue;
    }
    const referenceCandidates = [row.ref_embedding, ...(row.gallery_embeddings ?? [])].filter(
      (e): e is number[] => e != null,
    );
    if (referenceCandidates.length > 0) {
      const imageScore = Math.max(...referenceCandidates.map((e) => cosineSimilarity(embedding, e))) * adjustment;
      scored.push({
        id: row.species_id,
        common_name: row.common_name,
        scientific_name: row.scientific_name,
        score: blendWithText(imageScore, embedding, row.text_embedding),
        source: "reference_photo",
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  markConfidence(scored);
  assignDisplayPercents(scored);
  return trimLowRelevance(scored, limit);
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
  takenAt: Date | null = null,
): Promise<SpeciesSuggestion[]> {
  if (embeddings.length === 0) return [];
  const candidateCte = regionId
    ? `SELECT species_id, is_vagrant, local_tier, seasonality FROM region_species WHERE region_id = $3`
    : `SELECT species_id, NULL::boolean AS is_vagrant, NULL::text AS local_tier, NULL::numeric[] AS seasonality
       FROM user_species WHERE user_id = $1
       UNION
       SELECT ps.species_id, NULL, NULL, NULL FROM pack_species ps
       JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`;

  const candidatesRes = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    embedding: number[] | null;
    ref_embedding: number[] | null;
    gallery_embeddings: number[][] | null;
    is_vagrant: boolean | null;
    local_tier: string | null;
    seasonality: number[] | null;
    text_embedding: number[] | null;
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
       sre.embedding AS ref_embedding,
       (SELECT array_agg(ge.embedding) FROM species_reference_gallery_embeddings ge
          WHERE ge.species_id = s.id AND ge.model_version = $2) AS gallery_embeddings,
       cs.is_vagrant,
       cs.local_tier,
       cs.seasonality,
       ste.embedding AS text_embedding
     FROM candidate_species cs
     JOIN species s ON s.id = cs.species_id
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $2
     LEFT JOIN species_text_embeddings ste ON ste.species_id = s.id
     -- Every suggestion card fetches /species/:id/reference-photo/thumb regardless of source
     -- (your_photos included — see SuggestionCard.tsx), so a species with neither a cached
     -- local file NOR a live remote URL to recover one from (reference_photo) always renders
     -- as a blank placeholder card. Excluded here rather than left to the frontend to hide,
     -- so a real 4th/5th candidate can take that slot instead of the list just running short.
     WHERE s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL`,
    regionId ? [userId, EMBEDDING_MODEL_VERSION, regionId] : [userId, EMBEDDING_MODEL_VERSION],
  );

  const scored: SpeciesSuggestion[] = [];
  for (const row of candidatesRes.rows) {
    const targets = row.embedding ? [row.embedding] : [row.ref_embedding, ...(row.gallery_embeddings ?? [])].filter((e): e is number[] => e != null);
    if (targets.length === 0) continue;
    const source: SpeciesSuggestion["source"] = row.embedding ? "your_photos" : "reference_photo";
    const adjustment = occurrenceAdjustment({ isVagrant: row.is_vagrant, localTier: row.local_tier, seasonality: row.seasonality }, takenAt);
    let bestScore = -Infinity;
    let bestFrame = embeddings[0];
    for (const frameEmbedding of embeddings) {
      for (const target of targets) {
        const score = cosineSimilarity(frameEmbedding, target);
        if (score > bestScore) {
          bestScore = score;
          bestFrame = frameEmbedding;
        }
      }
    }
    const sourceFactor = source === "your_photos" ? YOUR_PHOTOS_SCORE_FACTOR : 1;
    const imageScore = bestScore * adjustment * sourceFactor;
    scored.push({
      id: row.species_id,
      common_name: row.common_name,
      scientific_name: row.scientific_name,
      score: blendWithText(imageScore, bestFrame, row.text_embedding),
      source,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  markConfidence(scored);
  assignDisplayPercents(scored);
  return trimLowRelevance(scored, limit);
}

/** Thin wrapper for callers that haven't already computed this photo's embedding for some
 * other reason — computes it fresh, then ranks the same way rankSpeciesByEmbedding does. */
export async function suggestSpecies(
  pool: Pool,
  userId: string,
  buffer: Buffer,
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
): Promise<SpeciesSuggestion[]> {
  const embedding = await computeSuggestionEmbedding(buffer);
  return rankSpeciesByEmbedding(pool, userId, embedding, regionId, limit, takenAt);
}
