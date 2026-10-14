// The same shot imported twice (re-processed, so a content hash can't catch it).
import type { Pool, PoolClient } from "pg";
import { userIndex, captureVectors } from "./userIndex.js";
import { cosineSimilarity } from "./vectorCache.js";
import { CLIP_SPACE } from "./vectorSpaces.js";

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
export async function findNearDuplicate(
  pool: Pool | PoolClient,
  userId: string,
  embedding: ArrayLike<number>,
  threshold = 0.95,
): Promise<NearDuplicate | null> {
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
