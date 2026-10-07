// Backfills capture_embeddings for every confirmed capture without a current one, at startup.
// Job state is a module-level object a status route reads.
import { pool } from "@lifer/core/db.js";
import {
  isInferenceStuck,
  photoVector,
  refreshSpeciesVectors,
  storeCaptureEmbedding,
  storeIdCaptureEmbedding,
} from "@lifer/core/species/embeddings.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "@lifer/core/config.js";
import { idModel } from "@lifer/core/species/idModel.js";

interface EmbeddingBackfillState {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  finishedAt: number | null;
}

export const embeddingBackfillJob: EmbeddingBackfillState = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
  finishedAt: null,
};

/** Embeds each capture's display photo (never the original) at background priority. A hung
 * model run is stopped by inference.ts, so one bad image can't stall the rest. */
async function backfillOne(captureId: string, displayPath: string): Promise<void> {
  const embedding = await photoVector("clip", { path: displayPath }, { priority: "background" });
  await storeCaptureEmbedding(pool, captureId, embedding);
}

export async function runEmbeddingBackfill(): Promise<void> {
  if (embeddingBackfillJob.running) return;
  embeddingBackfillJob.running = true;
  embeddingBackfillJob.error = null;
  embeddingBackfillJob.finishedAt = null;
  embeddingBackfillJob.processed = 0;

  try {
    const missingRes = await pool.query<{ id: string; display_path: string }>(
      `SELECT c.id, p.display_path
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $1
       WHERE ce.capture_id IS NULL AND p.display_path IS NOT NULL`,
      [EMBEDDING_MODEL_VERSION],
    );
    embeddingBackfillJob.total = missingRes.rows.length;

    for (const row of missingRes.rows) {
      // Stop rather than queue thousands of calls behind a hung native inference.
      if (isInferenceStuck()) throw new Error("Stopped: species matching is stuck on an earlier photo");
      try {
        await backfillOne(row.id, row.display_path);
      } catch {
        // An unreadable display file leaves that capture without suggestions; the backfill goes on.
      }
      embeddingBackfillJob.processed++;
    }
  } catch (err) {
    embeddingBackfillJob.error = (err as Error).message;
  } finally {
    embeddingBackfillJob.running = false;
    embeddingBackfillJob.finishedAt = Date.now();
  }
}

// Species enriched while the model wasn't downloaded have no reference vector; this fills
// them in once it is.
interface SpeciesEmbeddingBackfillState {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  finishedAt: number | null;
}

export const speciesEmbeddingBackfillJob: SpeciesEmbeddingBackfillState = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
  finishedAt: null,
};

export async function runSpeciesEmbeddingBackfill(): Promise<void> {
  if (speciesEmbeddingBackfillJob.running) return;
  speciesEmbeddingBackfillJob.running = true;
  speciesEmbeddingBackfillJob.error = null;
  speciesEmbeddingBackfillJob.finishedAt = null;
  speciesEmbeddingBackfillJob.processed = 0;

  try {
    const missingRes = await pool.query<{ id: string; reference_display_path: string }>(
      `SELECT s.id, s.reference_display_path
       FROM species s
       LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $1
       WHERE s.reference_display_path IS NOT NULL AND sre.species_id IS NULL`,
      [EMBEDDING_MODEL_VERSION],
    );
    speciesEmbeddingBackfillJob.total = missingRes.rows.length;

    const stored: string[] = [];
    try {
      for (const row of missingRes.rows) {
        if (isInferenceStuck()) throw new Error("Stopped: species matching is stuck on an earlier photo");
        try {
          const embedding = await photoVector("clip", { path: row.reference_display_path }, { priority: "background" });
          await pool.query(
            `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
             VALUES ($1, $2, $3)
             ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
            [row.id, Array.from(embedding), EMBEDDING_MODEL_VERSION],
          );
          stored.push(row.id);
        } catch {
          // one unreadable/corrupt reference photo shouldn't stop the whole backfill
        }
        speciesEmbeddingBackfillJob.processed++;
      }
    } finally {
      // Suggestions keep candidate vectors in memory; these species' new ones should count now.
      await refreshSpeciesVectors(pool, stored).catch(() => {});
    }
  } catch (err) {
    speciesEmbeddingBackfillJob.error = (err as Error).message;
  } finally {
    speciesEmbeddingBackfillJob.running = false;
    speciesEmbeddingBackfillJob.finishedAt = Date.now();
  }
}

// The identification model's side of both catch-ups above, for captures and for species with a
// local reference photo but no published vector. Runs at startup and after the model downloads.
export const idEmbeddingBackfillJob: EmbeddingBackfillState = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
  finishedAt: null,
};

export async function runIdEmbeddingBackfill(): Promise<void> {
  if (idEmbeddingBackfillJob.running || !idModel.isDownloaded()) return;
  idEmbeddingBackfillJob.running = true;
  idEmbeddingBackfillJob.error = null;
  idEmbeddingBackfillJob.finishedAt = null;
  idEmbeddingBackfillJob.processed = 0;

  try {
    const captures = await pool.query<{ id: string; display_path: string }>(
      `SELECT c.id, p.display_path
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       LEFT JOIN id_model_capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $1
       WHERE ce.capture_id IS NULL AND p.display_path IS NOT NULL`,
      [ID_MODEL_VERSION],
    );
    const species = await pool.query<{ id: string; reference_display_path: string }>(
      `SELECT s.id, s.reference_display_path
       FROM species s
       LEFT JOIN id_model_reference_embeddings e ON e.species_id = s.id AND e.model_version = $1
       WHERE s.reference_display_path IS NOT NULL AND e.species_id IS NULL`,
      [ID_MODEL_VERSION],
    );
    idEmbeddingBackfillJob.total = captures.rows.length + species.rows.length;

    for (const row of captures.rows) {
      if (idModel.isStuck()) throw new Error("Stopped: species identification is stuck on an earlier photo");
      try {
        await storeIdCaptureEmbedding(pool, row.id, { path: row.display_path }, { priority: "background" });
      } catch {
        // one unreadable display file shouldn't stop the whole backfill
      }
      idEmbeddingBackfillJob.processed++;
    }
    const stored: string[] = [];
    try {
      for (const row of species.rows) {
        if (idModel.isStuck()) throw new Error("Stopped: species identification is stuck on an earlier photo");
        try {
          // Reference photos are embedded uncropped, like the published ones.
          const embedding = await idModel.embedVector({ path: row.reference_display_path }, { priority: "background" });
          await pool.query(
            `INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version)
             VALUES ($1, $2, $3)
             ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
            [row.id, Array.from(embedding), ID_MODEL_VERSION],
          );
          stored.push(row.id);
        } catch {
          // one unreadable reference photo shouldn't stop the whole backfill
        }
        idEmbeddingBackfillJob.processed++;
      }
    } finally {
      await refreshSpeciesVectors(pool, stored).catch(() => {});
    }
  } catch (err) {
    idEmbeddingBackfillJob.error = (err as Error).message;
  } finally {
    idEmbeddingBackfillJob.running = false;
    idEmbeddingBackfillJob.finishedAt = Date.now();
  }
}
