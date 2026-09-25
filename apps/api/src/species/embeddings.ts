// Species auto-suggest — local-first nearest-neighbor search over pretrained image embeddings
// (see ~/.claude/plans/vast-prancing-turing.md, Phases 1-2: on by default, nothing ever leaves
// the device). No pgvector: the desktop app's embedded Postgres ships no extensions, so
// candidate vectors are plain `real[]` columns (capture_embeddings/species_reference_embeddings,
// migration 058) and ranking is done here in plain JS — fine at personal-library scale (at most
// a few thousand vectors, brute-force cosine similarity is sub-100ms with no native dependency).
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { APP_DATA_DIR, EMBEDDING_MODEL_URL, EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { cropToSubject } from "./detectAndCrop.js";
import { idModel } from "./idModel.js";
import { createOnnxImageModel, l2Normalize } from "./onnxImageModel.js";

export { l2Normalize };

// Opt-in, offload-able download, same shape as the offline basemap (settings/routes.ts's
// /settings/map/* routes). Not bundled at build time on any platform: this directory (holding
// the CLIP vision model, the species identification model, and textEmbedding.ts's own
// clip-text-cache subdirectory) is deleted wholesale on offload.
export const MODEL_DIR = path.join(APP_DATA_DIR, "models");

const clipModel = createOnnxImageModel({
  path: path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`),
  url: EMBEDDING_MODEL_URL,
  label: "the species-matching model",
  missingMessage: "The species-matching model hasn't been downloaded (Settings > Offline Data)",
});

/** Whether the CLIP vision model has been downloaded. Cheap, sync, safe to call from a status
 * endpoint on every poll. */
export function isModelDownloaded(): boolean {
  return clipModel.isDownloaded();
}

/** Deletes the whole model directory (both vision models plus textEmbedding.ts's cached text
 * encoder) to reclaim disk space, and frees the loaded sessions once nothing is mid-inference.
 * Safe to call even if nothing was ever downloaded. */
export function offloadModel(): void {
  rmSync(MODEL_DIR, { recursive: true, force: true });
  clipModel.release();
  idModel.release();
}

/** Downloads the CLIP vision model (~307MB), resuming a partial file. */
export async function downloadModel(
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  await clipModel.download(onProgress, signal);
}

export function isInferenceStuck(): boolean {
  return clipModel.isStuck();
}

/** L2-normalized CLIP embedding for one image. Never touches the network beyond the one-time
 * model download; guarded by a hard timeout (see onnxImageModel.ts). */
// Importing a photo computes the same vectors twice: once while checking it (near-duplicates,
// suggestions) and again after it's saved, for the same file bytes. Remembering the last few
// hundred results by content hash makes the second pass free (about 0.5s per photo on a fast
// machine, several seconds on a NAS). Keyed by model, so a model update never reuses old ones.
const VECTOR_MEMO_SIZE = 300;
const vectorMemo = new Map<string, Promise<number[]>>();

function memoVector(kind: string, buffer: Buffer, compute: () => Promise<number[]>): Promise<number[]> {
  const key = `${kind}:${createHash("sha256").update(buffer).digest("hex")}`;
  const hit = vectorMemo.get(key);
  if (hit) {
    vectorMemo.delete(key); // move to the newest end
    vectorMemo.set(key, hit);
    return hit;
  }
  const pending = compute();
  vectorMemo.set(key, pending);
  pending.catch(() => vectorMemo.delete(key)); // a failure isn't worth remembering
  if (vectorMemo.size > VECTOR_MEMO_SIZE) vectorMemo.delete(vectorMemo.keys().next().value!);
  return pending;
}

export async function computeEmbedding(buffer: Buffer): Promise<number[]> {
  return memoVector(`clip:${EMBEDDING_MODEL_VERSION}`, buffer, () => clipModel.embed(buffer));
}

const CROP_TIMEOUT_MS = 20_000;

/** Crops to the detected animal (detectAndCrop.ts) for suggestion-time matching. The crop runs
 * its own detection model, so it gets a time cap; on timeout or failure, the whole photo. */
async function cropForSuggestion(buffer: Buffer): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<Buffer>((resolve) => {
    timer = setTimeout(() => resolve(buffer), CROP_TIMEOUT_MS);
  });
  return Promise.race([cropToSubject(buffer).catch(() => buffer), timeout]).finally(() => clearTimeout(timer));
}

/** Same as computeEmbedding, but crops to the detected animal first. Use this specifically for
 * SUGGESTION-time embeddings, never for the reference/gallery database or for near-duplicate
 * detection. Real evaluation showed cropping the query photo alone (leaving every stored
 * reference/gallery embedding as-is) captured the whole measured benefit; cropping is
 * deliberately NOT applied to near-duplicate detection's own embedding, since that check
 * compares against OTHER un-cropped capture_embeddings rows and needs the same preprocessing on
 * both sides to mean anything. */
export async function computeSuggestionEmbedding(buffer: Buffer): Promise<number[]> {
  return memoVector(`clip-crop:${EMBEDDING_MODEL_VERSION}`, buffer, async () => clipModel.embed(await cropForSuggestion(buffer)));
}

/** The species identification model's embedding of the subject-cropped photo. Used both for a
 * suggestion query and for a capture's own stored vector (id_model_capture_embeddings), so the
 * two sides of "you've photographed this before" are computed the same way. */
export async function computeIdSuggestionEmbedding(buffer: Buffer): Promise<number[]> {
  return memoVector(`id-crop:${ID_MODEL_VERSION}`, buffer, async () => idModel.embed(await cropForSuggestion(buffer)));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
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
const YOUR_PHOTOS_MAX = 20;

// Everything a species can be matched against: the user's own photos of it (discounted, see
// above) AND its reference/gallery photos, best match wins. Your own photos used to REPLACE the
// gallery instead, and only the single most recent one counted, so a species got harder to
// recognize once you'd photographed it (benchmark on a real library: 21/55 top-1 with your
// photos available vs 33/55 with them hidden).
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

// Which model's vectors a ranking runs on, and that model's own calibration. The CLIP constants
// above were tuned on CLIP's score scale; the species identification model's text and image
// similarities land in different ranges, so it carries its own (derived the same way, from the
// same real-library leave-one-out data; see ID_SPACE).
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
  /** "Roughly as decisive as this data ever gets": scales matchPercent and cuts low-relevance
   * alternatives (see DISPLAY_MARGIN_SCALE / RELEVANCE_MARGIN below). */
  marginScale: number;
}

// Must match TEXT_MODEL_VERSION in textEmbedding.ts (not imported, to keep this file free of the
// text model's transformers.js dependency).
const CLIP_TEXT_MODEL_VERSION = "clip-vit-l14-text-v1";

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

// Derived the same way as CONFIDENCE_MARGIN above, from leave-one-out data on the same real
// library (55 photos, BC checklist, run through this code end to end: 51 correct top-1s, 4
// wrong). Every wrong top-1 won by at most 0.026, so the margin sits just above that: zero
// falsely confident picks in that data, about half of the correct ones confident. Correct
// margins topped out at 0.047, so the relevance/display scale stays at 0.05. Blended scores run
// much higher than CLIP's here (every top pick, right or wrong, scored 0.71-0.89), so the floor
// is only a no-signal guard. Launch values from a small sample, like CLIP's.
const ID_CONFIDENCE_FLOOR = 0.6;
const ID_CONFIDENCE_MARGIN = 0.027;
const ID_MARGIN_SCALE = 0.05;

// The same 0.7 text weight won here too, untuned (benchmark on a real library, 55 photos over
// the Canada and BC checklists: 51/55 top-1 with the gallery blended in vs 50/55 text-only, and
// 55/55 in the top five). Calibration: see ID_CONFIDENCE_MARGIN.
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

/** Blends the image-image score with this candidate's zero-shot text-prompt score, when one's
 * available (species_text_embeddings hasn't necessarily been backfilled for every species/model
 * version yet) — falls back to the pure image score otherwise, same graceful-degradation shape
 * every other optional signal in this file already uses. */
function blendWithText(imageScore: number, embedding: ArrayLike<number>, textEmbedding: ArrayLike<number> | null, textWeight: number): number {
  if (!textEmbedding) return imageScore;
  const textScore = cosineSimilarity(embedding, textEmbedding);
  return (1 - textWeight) * imageScore + textWeight * textScore;
}

/** Marks the single top-ranked candidate (only) as `confident` when it clears BOTH the floor and
 * the margin-over-runner-up bar — see CONFIDENCE_MARGIN's own comment for why a margin, not an
 * absolute cutoff, is what the blended score actually needs. Mutates in place; expects `scored`
 * already sorted descending by score. */
function markConfidence(scored: SpeciesSuggestion[], space: VectorSpace): void {
  if (scored.length === 0) return;
  const runnerUpScore = scored[1]?.score ?? -Infinity;
  scored[0].confident = scored[0].score >= space.confidenceFloor && scored[0].score - runnerUpScore >= space.confidenceMargin;
}

// A margin of this size (top pick vs. runner-up) is roughly as decisive as this data ever gets
// — the real leave-one-out calibration's correct-top-1 margins topped out around 0.053 (see
// CONFIDENCE_MARGIN's own comment). Used only to scale matchPercent below, not to gate anything.
// (CLIP_SPACE.marginScale; each VectorSpace carries its own.)
const DISPLAY_BASE_PERCENT = 50;
const DISPLAY_TOP_PERCENT = 99;

// How far a candidate's own RAW score can trail the top pick's before it stops being a real
// alternative — same scale DISPLAY_MARGIN_SCALE uses ("roughly as decisive as this data ever
// gets"), reused here as a real relevance cutoff rather than a display-only constant.
//
// This used to be decided from the cascading matchPercent instead (see assignDisplayPercents):
// every rank step subtracts AT LEAST 5 display points regardless of how close the real scores
// actually are, so a tight cluster of genuinely similar candidates (visually close species —
// confirmed live with Cedar/Bohemian Waxwing) could lose 20+ points by sheer rank position alone
// and cross MIN_DISPLAY_PERCENT even though their raw scores were barely distinguishable from
// the top pick's. That made the whole suggestion list fragile to tiny reordering: quantized ONNX
// inference isn't guaranteed bit-identical across CPU architectures (confirmed live — the exact
// same photo scored Cedar Waxwing #1 at 60% on one machine and outside the top 5 on another),
// and a display-position-based cutoff turned that small, expected numerical noise into a
// candidate vanishing from the list entirely rather than just shuffling within it. Comparing
// against the WINNER's own raw score directly is immune to that: a close cluster stays a close
// cluster (and stays visible) no matter which member tiny platform noise happens to rank first.
// (Also VectorSpace.marginScale.)

/** Cuts the ranked list off at the first item whose RAW score trails the top pick's by more than
 * the space's marginScale (the top pick, index 0, is always kept regardless): a candidate that's
 * genuinely close to the winner stays visible regardless of its rank position; one that's
 * genuinely far behind gets cut regardless of how small the gap to ITS OWN neighbor looks.
 * Expects `scored` already sorted descending by score. */
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
function assignDisplayPercents(scored: SpeciesSuggestion[], space: VectorSpace): void {
  const DISPLAY_MARGIN_SCALE = space.marginScale;
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
interface CandidateRow {
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  your_embeddings: ArrayLike<number>[] | null;
  ref_embedding: ArrayLike<number> | null;
  gallery_embeddings: ArrayLike<number>[] | null;
  is_vagrant: boolean | null;
  local_tier: string | null;
  seasonality: number[] | null;
  text_embedding: ArrayLike<number> | null;
}

// A region's candidate species with their reference, gallery and text vectors, kept in memory.
// Reading them from Postgres on every suggestion (every photo checked on import) meant parsing
// millions of numbers per photo for Canada's ~2,000 species: 2.2s of the 2.6s a suggestion took
// on a fast machine, and far longer on a NAS. They only change with a catalog, vector or pack
// install (which call invalidateSuggestionCache) or a one-off species enrichment (picked up by
// the refresh after SUGGESTION_CACHE_TTL_MS).
const SUGGESTION_CACHE_TTL_MS = 10 * 60_000;
type CatalogRow = Omit<CandidateRow, "your_embeddings">;
const regionCatalogCache = new Map<string, { at: number; rows: Promise<CatalogRow[]> }>();

export function invalidateSuggestionCache(): void {
  regionCatalogCache.clear();
}

// Entries were only replaced when read again, so a region looked up once stayed in memory (tens
// of MB for a large region) for as long as the server ran. Expired ones are dropped here, and
// your photos' vectors too once suggestions have gone unused for as long.
let lastSuggestionUse = 0;
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of regionCatalogCache) if (now - hit.at >= SUGGESTION_CACHE_TTL_MS) regionCatalogCache.delete(key);
  if (now - lastSuggestionUse >= SUGGESTION_CACHE_TTL_MS) yourVectorCache.clear();
}, 60_000).unref();

const toVec = (v: number[] | null): Float32Array | null => (v ? Float32Array.from(v) : null);

function regionCatalog(pool: Pool | PoolClient, regionId: string, space: VectorSpace): Promise<CatalogRow[]> {
  const key = `${space.modelVersion}|${space.textModelVersion}|${regionId}`;
  const hit = regionCatalogCache.get(key);
  if (hit && Date.now() - hit.at < SUGGESTION_CACHE_TTL_MS) return hit.rows;
  const rows = pool
    .query<{
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
      `SELECT s.id AS species_id, s.common_name, s.scientific_name,
              sre.embedding AS ref_embedding,
              (SELECT array_agg(ge.embedding) FROM ${space.galleryTable} ge
                 WHERE ge.species_id = s.id AND ge.model_version = $1) AS gallery_embeddings,
              rs.is_vagrant, rs.local_tier, rs.seasonality,
              ste.embedding AS text_embedding
         FROM region_species rs
         JOIN species s ON s.id = rs.species_id
         LEFT JOIN ${space.referenceTable} sre ON sre.species_id = s.id AND sre.model_version = $1
         LEFT JOIN ${space.textTable} ste ON ste.species_id = s.id AND ste.model_version = $2
        WHERE rs.region_id = $3
          -- A species with no photo to show would render as a blank suggestion card.
          AND (s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL)`,
      [space.modelVersion, space.textModelVersion, regionId],
    )
    .then((res) =>
      res.rows.map((r) => ({
        ...r,
        ref_embedding: toVec(r.ref_embedding),
        gallery_embeddings: r.gallery_embeddings?.map((g) => Float32Array.from(g)) ?? null,
        text_embedding: toVec(r.text_embedding),
      })),
    );
  regionCatalogCache.set(key, { at: Date.now(), rows });
  rows.catch(() => regionCatalogCache.delete(key));
  return rows;
}

// Your own photos' vectors (up to the YOUR_PHOTOS_MAX newest per species), also kept in memory.
// Only ids and timestamps are read per request; a vector is fetched once, and again only when
// it's recomputed.
const yourVectorCache = new Map<string, { computedAt: string; vec: Float32Array }>();

async function yourVectorsBySpecies(pool: Pool | PoolClient, userId: string, space: VectorSpace): Promise<Map<string, Float32Array[]>> {
  const res = await pool.query<{ capture_id: string; species_id: string; computed_at: string }>(
    `SELECT capture_id, species_id, computed_at FROM (
       SELECT ce.capture_id, c.species_id, ce.computed_at::text AS computed_at,
              row_number() OVER (PARTITION BY c.species_id ORDER BY ce.computed_at DESC) AS rn
         FROM ${space.captureTable} ce JOIN captures c ON c.id = ce.capture_id
        WHERE c.user_id = $1 AND ce.model_version = $2
     ) x WHERE rn <= ${YOUR_PHOTOS_MAX}`,
    [userId, space.modelVersion],
  );
  const cacheKey = (id: string) => `${space.captureTable}:${id}`;
  const missing = res.rows.filter((r) => yourVectorCache.get(cacheKey(r.capture_id))?.computedAt !== r.computed_at);
  for (let i = 0; i < missing.length; i += 2000) {
    const batch = missing.slice(i, i + 2000);
    const vecs = await pool.query<{ capture_id: string; embedding: number[]; computed_at: string }>(
      `SELECT capture_id, embedding, computed_at::text AS computed_at FROM ${space.captureTable} WHERE capture_id = ANY($1::uuid[]) AND model_version = $2`,
      [batch.map((r) => r.capture_id), space.modelVersion],
    );
    for (const v of vecs.rows) yourVectorCache.set(cacheKey(v.capture_id), { computedAt: v.computed_at, vec: Float32Array.from(v.embedding) });
  }
  const bySpecies = new Map<string, Float32Array[]>();
  for (const r of res.rows) {
    const hit = yourVectorCache.get(cacheKey(r.capture_id));
    if (!hit || hit.computedAt !== r.computed_at) continue;
    if (!bySpecies.has(r.species_id)) bySpecies.set(r.species_id, []);
    bySpecies.get(r.species_id)!.push(hit.vec);
  }
  return bySpecies;
}

async function regionCandidates(pool: Pool | PoolClient, userId: string, regionId: string, space: VectorSpace): Promise<CandidateRow[]> {
  lastSuggestionUse = Date.now();
  const [catalog, yours] = await Promise.all([regionCatalog(pool, regionId, space), yourVectorsBySpecies(pool, userId, space)]);
  return catalog.map((row) => ({ ...row, your_embeddings: yours.get(row.species_id) ?? null }));
}

// No region picked: candidates are your own species plus every downloaded pack's, which change
// with every upload, so this path reads them fresh.
async function libraryCandidates(pool: Pool | PoolClient, userId: string, space: VectorSpace): Promise<CandidateRow[]> {
  const candidateCte = `SELECT species_id, NULL::boolean AS is_vagrant, NULL::text AS local_tier, NULL::numeric[] AS seasonality
       FROM user_species WHERE user_id = $1
       UNION
       SELECT ps.species_id, NULL, NULL, NULL FROM pack_species ps
       JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`;

  const candidatesRes = await pool.query<{
    species_id: string;
    common_name: string | null;
    scientific_name: string;
    your_embeddings: number[][] | null;
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
       -- The user's own captures of this species, if any (only their own captures, another
       -- user's photos are never compared against, even on a shared server deployment). Up to
       -- the 20 most recent, matched by whichever fits best, like the gallery below.
       (SELECT array_agg(y.embedding) FROM (
          SELECT ce.embedding FROM ${space.captureTable} ce
            JOIN captures c ON c.id = ce.capture_id
           WHERE c.species_id = s.id AND c.user_id = $1 AND ce.model_version = $2
           ORDER BY ce.computed_at DESC LIMIT ${YOUR_PHOTOS_MAX}) y) AS your_embeddings,
       sre.embedding AS ref_embedding,
       -- Every gallery photo's own embedding (migration 101). Matching against the best of
       -- SEVERAL reference poses, not just the one main photo, catches a real photo taken at a
       -- different angle than that single reference image (see this file's own module comment).
       (SELECT array_agg(ge.embedding) FROM ${space.galleryTable} ge
          WHERE ge.species_id = s.id AND ge.model_version = $2) AS gallery_embeddings,
       cs.is_vagrant,
       cs.local_tier,
       cs.seasonality,
       ste.embedding AS text_embedding
     FROM candidate_species cs
     JOIN species s ON s.id = cs.species_id
     LEFT JOIN ${space.referenceTable} sre ON sre.species_id = s.id AND sre.model_version = $2
     LEFT JOIN ${space.textTable} ste ON ste.species_id = s.id AND ste.model_version = $3
     -- Every suggestion card fetches /species/:id/reference-photo/thumb regardless of source
     -- (your_photos included — see SuggestionCard.tsx), so a species with neither a cached
     -- local file NOR a live remote URL to recover one from (reference_photo) always renders
     -- as a blank placeholder card. Excluded here rather than left to the frontend to hide,
     -- so a real 4th/5th candidate can take that slot instead of the list just running short.
     WHERE s.reference_display_path IS NOT NULL OR s.reference_photo IS NOT NULL`,
    [userId, space.modelVersion, space.textModelVersion],
  );

  return candidatesRes.rows;
}

export async function rankSpeciesByEmbedding(
  pool: Pool | PoolClient,
  userId: string,
  embedding: number[],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  space: VectorSpace = CLIP_SPACE,
): Promise<SpeciesSuggestion[]> {
  return rankSpeciesByEmbeddings(pool, userId, [embedding], regionId, limit, takenAt, space);
}

/** Same candidate scoring as rankSpeciesByEmbedding, but against SEVERAL embeddings at once
 * (e.g. multiple frames sampled from one video clip): a species scores by whichever single
 * embedding matched it best, not an average across all of them. Averaging would dilute a real
 * match: the animal is very unlikely to be clearly visible, well-framed, and in-focus in EVERY
 * sampled frame of a clip (some frames are mid-motion blur, some catch the subject leaving
 * frame, some are mostly background) the way a single deliberately-taken photo usually is, so
 * the frame that best captures it should decide the match, not get dragged down by the rest.
 * One shared candidate-species query (not one per embedding) keeps this to the same DB cost as
 * the single-embedding version regardless of how many frames were sampled. `embeddings` must
 * come from the model `space` describes. */
export async function rankSpeciesByEmbeddings(
  pool: Pool | PoolClient,
  userId: string,
  embeddings: number[][],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
  space: VectorSpace = CLIP_SPACE,
): Promise<SpeciesSuggestion[]> {
  if (embeddings.length === 0) return [];
  const rows = regionId ? await regionCandidates(pool, userId, regionId, space) : await libraryCandidates(pool, userId, space);

  const scored: SpeciesSuggestion[] = [];
  for (const row of rows) {
    const targets = matchTargets(row);
    if (targets.length === 0) continue;
    const adjustment = occurrenceAdjustment({ isVagrant: row.is_vagrant, localTier: row.local_tier, seasonality: row.seasonality }, takenAt);
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
      id: row.species_id,
      common_name: row.common_name,
      scientific_name: row.scientific_name,
      score: blendWithText(bestScore * adjustment, bestFrame, row.text_embedding, space.textWeight),
      source: best.source,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  markConfidence(scored, space);
  assignDisplayPercents(scored, space);
  return trimLowRelevance(scored, limit, space);
}

// Suggestions run on the species identification model once it's downloaded AND its reference
// vectors are installed (they arrive as a separate catalog asset right after the model), and on
// CLIP otherwise. Checked per request; the "not yet" answer is only cached briefly so the switch
// happens soon after the vectors land, and a "yes" is cached for good.
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

/** For tests and for the vector installer, which knows the answer just changed. */
export function resetIdModelReadiness(): void {
  idVectorsInstalled = false;
  idVectorsCheckedAt = 0;
}

/** Suggests species for one photo: crops to the subject once, then ranks with the species
 * identification model when it's ready, else with CLIP. A failure on the identification model
 * (a stuck or corrupt session) falls back to CLIP rather than returning nothing. */
export async function suggestSpecies(
  pool: Pool,
  userId: string,
  buffer: Buffer,
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
): Promise<SpeciesSuggestion[]> {
  return suggestSpeciesForFrames(pool, userId, [buffer], regionId, limit, takenAt);
}

/** suggestSpecies for several frames of one clip (see rankSpeciesByEmbeddings). */
export async function suggestSpeciesForFrames(
  pool: Pool,
  userId: string,
  frames: Buffer[],
  regionId: string | null,
  limit = 5,
  takenAt: Date | null = null,
): Promise<SpeciesSuggestion[]> {
  if (frames.length === 0) return [];
  // Per frame, so a later storeIdCaptureEmbedding of the same photo reuses the vector.
  if (await idModelReady(pool)) {
    try {
      const embeddings: number[][] = [];
      for (const frame of frames) embeddings.push(await computeIdSuggestionEmbedding(frame));
      return await rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, ID_SPACE);
    } catch {
      // fall through to CLIP
    }
  }
  const embeddings: number[][] = [];
  for (const frame of frames) embeddings.push(await computeSuggestionEmbedding(frame));
  return rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, CLIP_SPACE);
}

/** Stores a capture's identification-model vector (from the subject-cropped photo) for the
 * "you've photographed this before" signal. Best-effort: a no-op when the model isn't
 * downloaded. */
export async function storeIdCaptureEmbedding(client: Pool | PoolClient, captureId: string, buffer: Buffer): Promise<void> {
  if (!idModel.isDownloaded()) return;
  const embedding = await computeIdSuggestionEmbedding(buffer);
  await client.query(
    `INSERT INTO id_model_capture_embeddings (capture_id, embedding, model_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (capture_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
    [captureId, embedding, ID_MODEL_VERSION],
  );
}
