// Backfills capture_embeddings for every existing confirmed capture that doesn't have a
// current one yet — runs automatically at server startup (see index.ts), no toggle, no
// first-launch step (Phase 2 of the auto-suggest plan: this is purely local, so it's on by
// default like any other feature). Same in-memory job-state + polling shape as
// offlinePacks/routes.ts's downloadJob — no dedicated jobs table, just a module-level object a
// status route can read.
import { pool } from "../db.js";
import { computeEmbedding, isInferenceStuck, storeCaptureEmbedding, storeIdCaptureEmbedding } from "./embeddings.js";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { idModel } from "./idModel.js";

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

const PER_CAPTURE_TIMEOUT_MS = 20_000;

/** Reads each capture's already-generated display photo (never the original — same file the
 * app already rendered from, no extra I/O against user-managed originals) to compute its
 * embedding. Captures with no current photo (shouldn't normally happen) are skipped. Wrapped in
 * a hard timeout — a single pathological image (a corrupt file the native ONNX/sharp bindings
 * hang on rather than cleanly error on) must never stall every capture behind it in the queue. */
async function backfillOne(captureId: string, displayPath: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const work = (async () => {
    const buffer = await readFile(displayPath);
    const embedding = await computeEmbedding(buffer);
    await storeCaptureEmbedding(pool, captureId, embedding);
  })();
  work.catch(() => {}); // see computeEmbedding's own comment — silences a losing-side rejection

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("embedding timed out")), PER_CAPTURE_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    // Without this, a backfill over thousands of captures leaves thousands of live timers
    // ticking down at once — see computeEmbedding's identical fix for why.
    clearTimeout(timer!);
  }
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
        // One unreadable/corrupt display file shouldn't stop the whole backfill — it just
        // stays without suggestions, same as any capture the model failed to embed.
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

// Species side of the same catch-up problem: a species enriched (built-in or Other Taxa) while
// the embedding model wasn't downloaded gets its reference embedding skipped (see
// lazyEnrich.ts's tryComputeReferenceEmbedding, best-effort by design). Previously this only
// ever got fixed by manually re-running packages/data-pipeline's standalone
// backfill-reference-embeddings.ts — ported here (same query/insert shape) so it can also run
// automatically the moment the model actually becomes available, not just on manual invocation.
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

    const { readFile } = await import("node:fs/promises");
    for (const row of missingRes.rows) {
      if (isInferenceStuck()) throw new Error("Stopped: species matching is stuck on an earlier photo");
      try {
        const embedding = await computeEmbedding(await readFile(row.reference_display_path));
        await pool.query(
          `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
          [row.id, embedding, EMBEDDING_MODEL_VERSION],
        );
      } catch {
        // one unreadable/corrupt reference photo shouldn't stop the whole backfill
      }
      speciesEmbeddingBackfillJob.processed++;
    }
  } catch (err) {
    speciesEmbeddingBackfillJob.error = (err as Error).message;
  } finally {
    speciesEmbeddingBackfillJob.running = false;
    speciesEmbeddingBackfillJob.finishedAt = Date.now();
  }
}

// The species identification model's side of both catch-ups above: every confirmed capture gets
// an id_model_capture_embeddings row (subject-cropped, see storeIdCaptureEmbedding), and every
// species with a local reference photo but no published vector gets one (Other Taxa, or anything
// enriched after the last catalog build). Runs at startup and right after the model downloads.
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
    const { readFile } = await import("node:fs/promises");
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
        await storeIdCaptureEmbedding(pool, row.id, await readFile(row.display_path));
      } catch {
        // one unreadable display file shouldn't stop the whole backfill
      }
      idEmbeddingBackfillJob.processed++;
    }
    for (const row of species.rows) {
      if (idModel.isStuck()) throw new Error("Stopped: species identification is stuck on an earlier photo");
      try {
        // Reference photos are stored uncropped, same as the published ones (the pipeline embeds
        // the whole reference photo).
        const embedding = await idModel.embed(await readFile(row.reference_display_path));
        await pool.query(
          `INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
          [row.id, embedding, ID_MODEL_VERSION],
        );
      } catch {
        // one unreadable reference photo shouldn't stop the whole backfill
      }
      idEmbeddingBackfillJob.processed++;
    }
  } catch (err) {
    idEmbeddingBackfillJob.error = (err as Error).message;
  } finally {
    idEmbeddingBackfillJob.running = false;
    idEmbeddingBackfillJob.finishedAt = Date.now();
  }
}
