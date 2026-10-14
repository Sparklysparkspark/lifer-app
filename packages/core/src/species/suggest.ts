// Species auto-suggest: local nearest-neighbor search over image embeddings, nothing leaves the
// device. The embedded Postgres has no pgvector, so vectors are plain real[] columns and ranking
// is brute-force cosine similarity in JS, which is fast enough at personal-library scale.
import { HUMAN_SCIENTIFIC_NAME } from "./neverListed.js";
import type { Pool, PoolClient } from "pg";
import { ID_MODEL_VERSION } from "../config.js";
import { log } from "../lib/log.js";
import { clipModel, isModelDownloaded } from "./clipModel.js";
import { idModel } from "./idModel.js";
import { warmModels, type Priority, type TextModelSpec } from "./inference.js";
import { findNearDuplicate } from "./nearDuplicate.js";
import {
  clearUserVectorCaches,
  lastSuggestionUseAt,
  noteSuggestionUse,
  userSpeciesIds,
  yourVectorsBySpecies,
} from "./userIndex.js";
import { cosineSimilarity, suggestionVectors } from "./vectorCache.js";
import { CLIP_SPACE, ID_SPACE, type VectorSpace } from "./vectorSpaces.js";

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

// Everything a species can be matched against: your own photos of it (discounted) and its
// reference and gallery photos. Best match wins.
export function matchTargets(row: {
  your_embeddings: ArrayLike<number>[] | null;
  ref_embedding: ArrayLike<number> | null;
  gallery_embeddings: ArrayLike<number>[] | null;
}): Array<{ embedding: ArrayLike<number>; factor: number; source: SpeciesSuggestion["source"] }> {
  return [
    ...(row.your_embeddings ?? []).map((embedding) => ({
      embedding,
      factor: YOUR_PHOTOS_SCORE_FACTOR,
      source: "your_photos" as const,
    })),
    ...[row.ref_embedding, ...(row.gallery_embeddings ?? [])]
      .filter((e): e is ArrayLike<number> => e != null)
      .map((embedding) => ({ embedding, factor: 1, source: "reference_photo" as const })),
  ];
}

/** Blends the image score with the candidate's text-prompt score, or returns the image score
 * when no text vector exists yet. */
function blendWithText(
  imageScore: number,
  embedding: ArrayLike<number>,
  textEmbedding: ArrayLike<number> | null,
  textWeight: number,
): number {
  if (!textEmbedding) return imageScore;
  const textScore = cosineSimilarity(embedding, textEmbedding);
  return (1 - textWeight) * imageScore + textWeight * textScore;
}

/** Marks the top candidate `confident` when it clears both the floor and the margin over the
 * runner-up. Mutates in place; expects `scored` sorted descending. */
function markConfidence(scored: SpeciesSuggestion[], space: VectorSpace): void {
  if (scored.length === 0) return;
  const runnerUpScore = scored[1]?.score ?? -Infinity;
  scored[0].confident =
    scored[0].score >= space.confidenceFloor && scored[0].score - runnerUpScore >= space.confidenceMargin;
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
  if (now - lastSuggestionUseAt() >= SUGGESTION_IDLE_MS) {
    invalidateSuggestionCache();
    clearUserVectorCaches();
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

async function fetchSpeciesVectors(
  pool: Pool | PoolClient,
  space: VectorSpace,
  ids: string[],
): Promise<Map<string, SpeciesVectors>> {
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
async function speciesVectors(
  pool: Pool | PoolClient,
  space: VectorSpace,
  ids: string[],
): Promise<Map<string, SpeciesVectors | null>> {
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

function regionCandidateSet(
  pool: Pool | PoolClient,
  regionId: string,
  space: VectorSpace,
): Promise<CandidateEntry[] | null> {
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
    .query<{ species_id: string }>(
      `SELECT DISTINCT ps.species_id FROM pack_species ps JOIN downloaded_packs dp ON dp.pack_id = ps.pack_id`,
    )
    .then((res) => res.rows.map((r) => r.species_id));
  const entry = { at: Date.now(), ids };
  packSpecies = entry;
  ids.catch(() => {
    if (packSpecies === entry) packSpecies = null;
  });
  return ids;
}

// No region picked: candidates are your own species plus every downloaded pack's.
async function libraryCandidateSet(
  pool: Pool | PoolClient,
  userId: string,
  space: VectorSpace,
): Promise<CandidateEntry[]> {
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

async function candidateEntries(
  pool: Pool | PoolClient,
  userId: string,
  regionId: string | null,
  space: VectorSpace,
): Promise<CandidateEntry[]> {
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
  noteSuggestionUse();
  const [entries, yours] = await Promise.all([
    candidateEntries(pool, userId, regionId, space),
    yourVectorsBySpecies(pool, userId, space),
  ]);

  const scored: SpeciesSuggestion[] = [];
  for (const entry of entries) {
    const sp = entry.species;
    if (sp.scientific_name === HUMAN_SCIENTIFIC_NAME) continue;
    const targets = matchTargets({
      your_embeddings: yours.get(sp.species_id) ?? null,
      ref_embedding: sp.ref_embedding,
      gallery_embeddings: sp.gallery_embeddings,
    });
    if (targets.length === 0) continue;
    const adjustment = occurrenceAdjustment(
      { isVagrant: entry.is_vagrant, localTier: entry.local_tier, seasonality: entry.seasonality },
      takenAt,
    );
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
export async function suggestionVectorKind(
  pool: Pool | PoolClient,
): Promise<{ kind: "id-crop" | "clip-crop"; space: VectorSpace } | null> {
  if (await idModelReady(pool)) return { kind: "id-crop", space: ID_SPACE };
  return isModelDownloaded() ? { kind: "clip-crop", space: CLIP_SPACE } : null;
}

/** Suggests species for one photo with the identification model when ready, else CLIP. An
 * identification-model inference failure is logged and falls back to CLIP. */
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
    // Only a failure to run the identification model falls back to CLIP; a database error ranking
    // its vectors would fail the CLIP ranking too, so it propagates.
    let embeddings: Float32Array[] | null = null;
    try {
      embeddings = (
        await Promise.all(frames.map((frame) => suggestionVectors(frame, "id-crop", { key, priority })))
      ).flat();
    } catch (err) {
      log.warn({ err }, "The identification model failed on this photo; suggesting with CLIP instead");
    }
    if (embeddings) return rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, ID_SPACE);
  }
  const embeddings = (
    await Promise.all(frames.map((frame) => suggestionVectors(frame, "clip-crop", { key, priority })))
  ).flat();
  return rankSpeciesByEmbeddings(pool, userId, embeddings, regionId, limit, takenAt, CLIP_SPACE);
}

/** Preloads models and the candidate set so the first photo checked doesn't pay for it. Best effort. */
export async function warmSuggestions(
  pool: Pool,
  userId: string,
  regionId: string | null,
  text: TextModelSpec | null,
): Promise<void> {
  const active = await suggestionVectorKind(pool);
  const models = [clipModel, idModel].filter((m) => m.isDownloaded()).map((m) => m.target(false));
  await Promise.all([
    models.length > 0 ? warmModels({ models, detector: true, text }) : Promise.resolve(),
    active
      ? rankSpeciesByEmbeddings(pool, userId, [new Float32Array(768)], regionId, 1, null, active.space).catch(() => {})
      : Promise.resolve(),
    isModelDownloaded() ? findNearDuplicate(pool, userId, new Float32Array(768), 2).catch(() => {}) : Promise.resolve(),
  ]);
}
