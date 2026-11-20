// Photo search ranking on the hub: the shared ranker (packages/shared) with the hub's CLIP text
// encoder and the image vectors in the database.
import { pool } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { captureVectors } from "@lifer/core/species/embeddings.js";
import { embedTextVectors } from "@lifer/core/species/textEmbedding.js";
import { makePictureScorer, rankSearch as rankWith, type ParsedQuery, type SearchRow } from "@lifer/shared";

export type { SearchOutcome, SearchRow } from "@lifer/shared";

// Photo vectors are cached in memory (shared with species/embeddings.ts), keyed by capture and
// computed_at so a recomputed vector replaces the old one. Stored vectors are unit length.
const score = makePictureScorer(
  (texts) => embedTextVectors(texts),
  (rows) =>
    captureVectors(
      pool,
      "capture_embeddings",
      EMBEDDING_MODEL_VERSION,
      rows.map((r) => ({ capture_id: r.capture_id, computed_at: r.embedding_computed_at })),
    ),
);

// The same, against each photo's background vector (the animal greyed out).
const backgroundScore = makePictureScorer(
  (texts) => embedTextVectors(texts),
  (rows) =>
    captureVectors(
      pool,
      "capture_background_embeddings",
      EMBEDDING_MODEL_VERSION,
      rows.map((r) => ({ capture_id: r.capture_id, computed_at: (r.background_computed_at as string | null) ?? null })),
    ),
);

/** Runs a parsed query over the rows the route already filtered (rating, taxa, dates...). */
export function rankSearch<R extends SearchRow>(
  q: string,
  parsed: ParsedQuery,
  rows: R[],
  regionSubtree: (regionIds: string[]) => Promise<Set<string>>,
  opts: { quick?: boolean } = {},
) {
  return rankWith(q, parsed, rows, regionSubtree, score, { ...opts, backgroundScore });
}
