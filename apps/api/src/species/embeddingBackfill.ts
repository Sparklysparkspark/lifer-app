// Backfills capture_embeddings for every confirmed capture without a current one, at startup.
// Each catch-up is a background job (lib/job.ts); its run() resolves once the job has finished.
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import {
  isInferenceStuck,
  photoVector,
  refreshSpeciesVectors,
  storeCaptureEmbedding,
  storeIdCaptureEmbedding,
} from "@lifer/core/species/embeddings.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION, SCENE_MODEL_VERSION } from "@lifer/core/config.js";
import { idModel } from "@lifer/core/species/idModel.js";
import { sceneModel, storeCaptureScene } from "@lifer/core/species/sceneModel.js";
import { createJob } from "../lib/job.js";

export const embeddingBackfillJob = createJob("embedding-backfill");

/** Embeds each capture's display photo (never the original) at background priority. A hung
 * model run is stopped by inference.ts, so one bad image can't stall the rest. */
async function backfillOne(captureId: string, displayPath: string): Promise<void> {
  const embedding = await photoVector("clip", { path: displayPath }, { priority: "background" });
  await storeCaptureEmbedding(pool, captureId, embedding);
}

export async function runEmbeddingBackfill(): Promise<void> {
  embeddingBackfillJob.start(async (ctx) => {
    const missingRes = await pool.query<{ id: string; display_path: string }>(
      `SELECT c.id, p.display_path
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       LEFT JOIN capture_embeddings ce ON ce.capture_id = c.id AND ce.model_version = $1
       WHERE ce.capture_id IS NULL AND p.display_path IS NOT NULL`,
      [EMBEDDING_MODEL_VERSION],
    );
    ctx.update({ total: missingRes.rows.length, processed: 0 });

    let processed = 0;
    for (const row of missingRes.rows) {
      // Stop rather than queue thousands of calls behind a hung native inference.
      if (isInferenceStuck()) throw new Error("Stopped: species matching is stuck on an earlier photo");
      try {
        await backfillOne(row.id, row.display_path);
      } catch {
        // An unreadable display file leaves that capture without suggestions; the backfill goes on.
      }
      ctx.update({ processed: ++processed });
    }
    return null;
  });
  await embeddingBackfillJob.settled();
}

// Species enriched while the model wasn't downloaded have no reference vector; this fills
// them in once it is.
export const speciesEmbeddingBackfillJob = createJob("species-embedding-backfill");

export async function runSpeciesEmbeddingBackfill(): Promise<void> {
  speciesEmbeddingBackfillJob.start(async (ctx) => {
    const missingRes = await pool.query<{ id: string; reference_display_path: string }>(
      `SELECT s.id, s.reference_display_path
       FROM species s
       LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $1
       WHERE s.reference_display_path IS NOT NULL AND sre.species_id IS NULL`,
      [EMBEDDING_MODEL_VERSION],
    );
    ctx.update({ total: missingRes.rows.length, processed: 0 });

    let processed = 0;
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
        ctx.update({ processed: ++processed });
      }
    } finally {
      // Suggestions keep candidate vectors in memory; these species' new ones should count now.
      await refreshSpeciesVectors(pool, stored).catch(() => {});
    }
    return null;
  });
  await speciesEmbeddingBackfillJob.settled();
}

// The identification model's side of both catch-ups above, for captures and for species with a
// local reference photo but no published vector. Runs at startup and after the model downloads.
export const idEmbeddingBackfillJob = createJob("id-embedding-backfill");

export async function runIdEmbeddingBackfill(): Promise<void> {
  if (!idModel.isDownloaded()) return;
  idEmbeddingBackfillJob.start(async (ctx) => {
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
    ctx.update({ total: captures.rows.length + species.rows.length, processed: 0 });

    let processed = 0;
    for (const row of captures.rows) {
      if (idModel.isStuck()) throw new Error("Stopped: species identification is stuck on an earlier photo");
      try {
        await storeIdCaptureEmbedding(pool, row.id, { path: row.display_path }, { priority: "background" });
      } catch {
        // one unreadable display file shouldn't stop the whole backfill
      }
      ctx.update({ processed: ++processed });
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
        ctx.update({ processed: ++processed });
      }
    } finally {
      await refreshSpeciesVectors(pool, stored).catch(() => {});
    }
    return null;
  });
  await idEmbeddingBackfillJob.settled();
}

// Scenes for Gallery search, for captures imported before the scene model was downloaded or whose
// photo has changed since. Runs after the identification backfill, at startup and after a download.
export const sceneBackfillJob = createJob("scene-backfill");

/** Captures whose current photo has no scene from this model version. */
export async function capturesNeedingScene(
  db: Pool | PoolClient,
): Promise<Array<{ id: string; photo_id: string; display_path: string }>> {
  const res = await db.query<{ id: string; photo_id: string; display_path: string }>(
    `SELECT c.id, p.id AS photo_id, p.display_path
     FROM captures c
     JOIN photos p ON p.id = c.current_photo_id
     LEFT JOIN capture_scenes cs ON cs.capture_id = c.id AND cs.model_version = $1 AND cs.photo_id = p.id
     WHERE cs.capture_id IS NULL AND p.display_path IS NOT NULL`,
    [SCENE_MODEL_VERSION],
  );
  return res.rows;
}

export async function runSceneBackfill(): Promise<void> {
  if (!sceneModel.isDownloaded()) return;
  sceneBackfillJob.start(async (ctx) => {
    const captures = await capturesNeedingScene(pool);
    ctx.update({ total: captures.length, processed: 0 });

    let processed = 0;
    for (const row of captures) {
      if (sceneModel.isStuck()) throw new Error("Stopped: the scene model is stuck on an earlier photo");
      try {
        await storeCaptureScene(pool, row.id, row.photo_id, { path: row.display_path }, { priority: "background" });
      } catch {
        // one unreadable display file shouldn't stop the whole backfill
      }
      ctx.update({ processed: ++processed });
    }
    return null;
  });
  await sceneBackfillJob.settled();
}
