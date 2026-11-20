// Where the animal sits in each photo, how the photo is lit, and what's behind the animal, for
// Gallery search by composition ("golden ratio"), light ("blue hour") and background ("tree in the
// background"). One detector pass and one decode give all three (inferenceWorker.ts).
import type { Pool, PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { clipModel, isInferenceStuck } from "@lifer/core/species/embeddings.js";
import { analyzeImage, type ImageSource, type Priority } from "@lifer/core/species/inference.js";
import { createJob } from "../lib/job.js";

/** Changes when how frames are read changes, so every photo is read again. */
export const FRAME_VERSION = "frame-v1";
// A background vector is kept only when the animal leaves this much of the frame (inferenceWorker.ts).
const BACKGROUND_MAX_SUBJECT_SHARE = 0.6;

/** Reads one capture's frame (and its background vector when the CLIP model is downloaded) and
 *  stores them against the photo they came from. Throws when the photo can't be read. */
export async function storeCaptureFrame(
  captureId: string,
  photoId: string,
  image: ImageSource,
  opts: { key?: string | null; priority: Priority },
): Promise<void> {
  const withBackground = clipModel.isDownloaded();
  const result = await analyzeImage(image, {
    targets: withBackground ? [{ ...clipModel.target(false), maskSubject: true }] : [],
    frame: true,
    key: opts.key ?? null,
    priority: opts.priority,
  });
  const f = result.frame;
  if (!f) throw new Error("Couldn't read this photo's frame");
  await pool.query(
    `INSERT INTO capture_frames (capture_id, photo_id, version, box, box_unsure, aspect, light)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (capture_id) DO UPDATE SET photo_id = EXCLUDED.photo_id, version = EXCLUDED.version,
       box = EXCLUDED.box, box_unsure = EXCLUDED.box_unsure, aspect = EXCLUDED.aspect, light = EXCLUDED.light,
       computed_at = now()`,
    [captureId, photoId, FRAME_VERSION, f.box, f.unsure, f.aspect, JSON.stringify(f.light)],
  );
  const vec = result.vectors[0];
  if (vec instanceof Float32Array) {
    await pool.query(
      `INSERT INTO capture_background_embeddings (capture_id, photo_id, embedding, model_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (capture_id) DO UPDATE SET photo_id = EXCLUDED.photo_id, embedding = EXCLUDED.embedding,
         model_version = EXCLUDED.model_version, computed_at = now()`,
      [captureId, photoId, Array.from(vec), EMBEDDING_MODEL_VERSION],
    );
  } else {
    // An older photo's background no longer describes this one.
    await pool.query(`DELETE FROM capture_background_embeddings WHERE capture_id = $1 AND photo_id <> $2`, [
      captureId,
      photoId,
    ]);
  }
}

/** Captures whose current photo has no frame of this version, or that could have a background
 *  vector now and don't. Only these are read, so a finished photo is never read again. */
export async function capturesNeedingFrame(
  db: Pool | PoolClient,
  withBackground: boolean,
): Promise<Array<{ id: string; photo_id: string; display_path: string }>> {
  const res = await db.query<{ id: string; photo_id: string; display_path: string }>(
    `SELECT c.id, p.id AS photo_id, p.display_path
     FROM captures c
     JOIN photos p ON p.id = c.current_photo_id
     LEFT JOIN capture_frames f ON f.capture_id = c.id AND f.photo_id = p.id AND f.version = $1
     LEFT JOIN capture_background_embeddings b
       ON b.capture_id = c.id AND b.photo_id = p.id AND b.model_version = $2
     WHERE p.display_path IS NOT NULL
       AND (f.capture_id IS NULL
            OR ($3 AND b.capture_id IS NULL AND f.box IS NOT NULL
                AND (f.box[3] - f.box[1]) * (f.box[4] - f.box[2]) <= $4))
     ORDER BY c.id`,
    [FRAME_VERSION, EMBEDDING_MODEL_VERSION, withBackground, BACKGROUND_MAX_SUBJECT_SHARE],
  );
  return res.rows;
}

// The background job. Each photo is stored as it's read, so a stopped run picks up where it was.
export const frameBackfillJob = createJob("search-frames-backfill");

export async function runFrameBackfill(): Promise<void> {
  frameBackfillJob.start(async (ctx) => {
    const captures = await capturesNeedingFrame(pool, clipModel.isDownloaded());
    ctx.update({ total: captures.length, processed: 0 });
    let processed = 0;
    for (const row of captures) {
      if (isInferenceStuck()) throw new Error("Stopped: the animal detector is stuck on an earlier photo");
      ctx.throwIfCancelled();
      try {
        await storeCaptureFrame(row.id, row.photo_id, { path: row.display_path }, { priority: "background" });
      } catch {
        // one unreadable display file shouldn't stop the whole backfill
      }
      ctx.update({ processed: ++processed });
    }
    return null;
  });
  await frameBackfillJob.settled();
}
