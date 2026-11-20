// Tells reference photos that show the animal apart from ones that don't (eggs, nests, tracks,
// scat, bones, dead specimens, habitat, maps, drawings, text), from each photo's stored CLIP
// vector and text prompts embedded once (portraitPromptVectors.ts). Nothing is deleted: the
// galleries list those photos last, and a species whose main photo is one of them swaps it with
// its best portrait (migration 189).
import type { PoolClient } from "pg";
import { EMBEDDING_MODEL_VERSION } from "../config.js";
import { withTransaction } from "../db.js";
import { PROMPTS, PROMPT_DIM, PROMPT_SCALES, PROMPT_VECTORS_INT8 } from "./portraitPromptVectors.js";

export const PORTRAIT = "portrait";

// How far a photo must match a non-portrait kind better than any portrait prompt to get that
// kind. Below about 0.03 adults sitting on nests, shells and small mammals on bare ground get
// caught; eggs/nests and scat need more for the same reason.
const MARGIN: Record<string, number> = { egg: 0.04, nest: 0.04, scat: 0.05 };
const DEFAULT_MARGIN = 0.03;

let decoded: Float32Array[] | null = null;
export function promptVectors(): Float32Array[] {
  if (decoded) return decoded;
  const bytes = new Int8Array(Buffer.from(PROMPT_VECTORS_INT8, "base64"));
  decoded = PROMPTS.map((_, i) =>
    Float32Array.from(bytes.subarray(i * PROMPT_DIM, (i + 1) * PROMPT_DIM), (b) => b * PROMPT_SCALES[i]),
  );
  return decoded;
}

/** score: the best portrait prompt's similarity minus the best other prompt's; higher is a
 *  better portrait. kind: "portrait", or the other kind when it wins by its margin. */
export function classifyReferencePhoto(embedding: ArrayLike<number>): { kind: string; score: number } {
  const best = new Map<string, number>();
  promptVectors().forEach((t, i) => {
    let dot = 0;
    for (let k = 0; k < t.length; k++) dot += embedding[k] * t[k];
    const kind = PROMPTS[i][0];
    if (dot > (best.get(kind) ?? -Infinity)) best.set(kind, dot);
  });
  const portrait = best.get(PORTRAIT)!;
  let other = PORTRAIT;
  let otherSim = -Infinity;
  for (const [kind, sim] of best) if (kind !== PORTRAIT && sim > otherSim) [other, otherSim] = [kind, sim];
  const score = portrait - otherSim;
  return { kind: -score > (MARGIN[other] ?? DEFAULT_MARGIN) ? other : PORTRAIT, score };
}

/** For a gallery ORDER BY: portraits and not-yet-scored photos first, the rest last. */
export const PORTRAITS_FIRST_SQL = (alias: string) =>
  `(${alias}.portrait_kind IS NOT NULL AND ${alias}.portrait_kind <> '${PORTRAIT}')`;

type Db = Pick<PoolClient, "query">;

/** Scores every unscored photo that has a vector, one small transaction per batch, pausing
 *  between batches so other database work gets its turn. Resumable: done rows are skipped. */
export async function scorePendingReferencePhotos(
  batch = 500,
  pauseMs = 0,
): Promise<{ scored: number; swapped: number }> {
  const total = { scored: 0, swapped: 0 };
  for (;;) {
    const r = await withTransaction((client) => scoreReferencePhotoBatch(client, batch));
    total.scored += r.scored;
    total.swapped += r.swapped;
    if (r.scored < batch) return total;
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

/** Scores up to `limit` unscored photos that have a vector (gallery photos, then main photos) and
 *  swaps the main photo of each species touched when it isn't a portrait. Returns how many photos
 *  it scored; 0 means nothing is left. */
export async function scoreReferencePhotoBatch(db: Db, limit = 500): Promise<{ scored: number; swapped: number }> {
  const gallery = await db.query<{ id: string; species_id: string; embedding: number[] }>(
    `SELECT p.id, p.species_id, e.embedding
       FROM species_reference_photos p
       JOIN species_reference_gallery_embeddings e ON e.reference_photo_id = p.id AND e.model_version = $1
      WHERE p.portrait_kind IS NULL
      LIMIT $2`,
    [EMBEDDING_MODEL_VERSION, limit],
  );
  const mains = await db.query<{ id: string; embedding: number[] }>(
    `SELECT s.id, e.embedding
       FROM species s
       JOIN species_reference_embeddings e ON e.species_id = s.id AND e.model_version = $1
      WHERE s.reference_portrait_kind IS NULL AND s.reference_photo IS NOT NULL
      LIMIT $2`,
    [EMBEDDING_MODEL_VERSION, Math.max(0, limit - gallery.rows.length)],
  );
  const scoreRows = (rows: Array<{ id: string; embedding: number[] }>) => {
    const out = { ids: [] as string[], kinds: [] as string[], scores: [] as number[] };
    for (const r of rows) {
      const c = classifyReferencePhoto(r.embedding);
      out.ids.push(r.id);
      out.kinds.push(c.kind);
      out.scores.push(c.score);
    }
    return out;
  };
  const g = scoreRows(gallery.rows);
  if (g.ids.length)
    await db.query(
      `UPDATE species_reference_photos p SET portrait_kind = v.kind, portrait_score = v.score
         FROM unnest($1::uuid[], $2::text[], $3::real[]) AS v(id, kind, score) WHERE p.id = v.id`,
      [g.ids, g.kinds, g.scores],
    );
  const m = scoreRows(mains.rows);
  if (m.ids.length)
    await db.query(
      `UPDATE species s SET reference_portrait_kind = v.kind, reference_portrait_score = v.score
         FROM unnest($1::uuid[], $2::text[], $3::real[]) AS v(id, kind, score) WHERE s.id = v.id`,
      [m.ids, m.kinds, m.scores],
    );
  const touched = [...new Set([...gallery.rows.map((r) => r.species_id), ...m.ids])];
  const swapped = await swapNonPortraitMainPhotos(db, touched);
  return { scored: g.ids.length + m.ids.length, swapped };
}

const VECTOR_TABLE_PAIRS = [
  ["species_reference_embeddings", "species_reference_gallery_embeddings"],
  ["id_model_reference_embeddings", "id_model_gallery_embeddings"],
] as const;

/** For each species whose main photo was scored as something other than a portrait, makes its
 *  best-scoring portrait gallery photo the main one and moves the old main photo (with its file,
 *  credit and vectors) into that gallery row, where the galleries list it last. */
export async function swapNonPortraitMainPhotos(db: Db, speciesIds: string[]): Promise<number> {
  if (speciesIds.length === 0) return 0;
  const pairs = await db.query<{ species_id: string; photo_id: string }>(
    `SELECT DISTINCT ON (s.id) s.id AS species_id, p.id AS photo_id
       FROM species s
       JOIN species_reference_photos p ON p.species_id = s.id AND p.portrait_kind = '${PORTRAIT}'
      WHERE s.id = ANY($1::uuid[]) AND s.reference_portrait_kind <> '${PORTRAIT}'
        AND p.photo_url IS DISTINCT FROM s.reference_photo
      ORDER BY s.id, p.portrait_score DESC, p.sort_order`,
    [speciesIds],
  );
  for (const { species_id: speciesId, photo_id: photoId } of pairs.rows) {
    // The old main photo may already sit in the gallery under its URL (a pack written before the
    // swap): that copy goes, since the swapped row takes the URL.
    await db.query(
      `DELETE FROM species_reference_photos p USING species s
        WHERE s.id = $1 AND p.species_id = s.id AND p.photo_url = s.reference_photo AND p.id <> $2`,
      [speciesId, photoId],
    );
    // One statement, so each side reads the other's values from before the update.
    await db.query(
      `WITH old AS (
         SELECT s.reference_photo, s.reference_credit, s.reference_license, s.reference_display_path,
                s.reference_thumb_path, s.reference_focal_x, s.reference_focal_y,
                s.reference_portrait_kind, s.reference_portrait_score,
                p.photo_url, p.credit, p.license, p.display_path, p.thumb_path, p.focal_x, p.focal_y,
                p.portrait_kind, p.portrait_score
           FROM species s JOIN species_reference_photos p ON p.id = $2 WHERE s.id = $1
       ), gallery AS (
         UPDATE species_reference_photos p SET
           photo_url = old.reference_photo, credit = COALESCE(old.reference_credit, ''),
           license = COALESCE(old.reference_license, ''), display_path = old.reference_display_path,
           thumb_path = old.reference_thumb_path, focal_x = old.reference_focal_x, focal_y = old.reference_focal_y,
           portrait_kind = old.reference_portrait_kind, portrait_score = old.reference_portrait_score
         FROM old WHERE p.id = $2
       )
       UPDATE species s SET
         reference_photo = old.photo_url, reference_credit = old.credit, reference_license = old.license,
         reference_display_path = old.display_path, reference_thumb_path = old.thumb_path,
         reference_focal_x = old.focal_x, reference_focal_y = old.focal_y,
         reference_portrait_kind = old.portrait_kind, reference_portrait_score = old.portrait_score
       FROM old WHERE s.id = $1`,
      [speciesId, photoId],
    );
    for (const [mainTable, galleryTable] of VECTOR_TABLE_PAIRS) {
      type Vec = { embedding: number[]; model_version: string };
      const m = await db.query<Vec>(
        `DELETE FROM ${mainTable} WHERE species_id = $1 RETURNING embedding, model_version`,
        [speciesId],
      );
      const g = await db.query<Vec>(
        `DELETE FROM ${galleryTable} WHERE reference_photo_id = $1 RETURNING embedding, model_version`,
        [photoId],
      );
      for (const v of g.rows)
        await db.query(`INSERT INTO ${mainTable} (species_id, embedding, model_version) VALUES ($1, $2, $3)`, [
          speciesId,
          v.embedding,
          v.model_version,
        ]);
      for (const v of m.rows)
        await db.query(
          `INSERT INTO ${galleryTable} (reference_photo_id, species_id, embedding, model_version) VALUES ($1, $2, $3, $4)`,
          [photoId, speciesId, v.embedding, v.model_version],
        );
    }
  }
  return pairs.rows.length;
}
