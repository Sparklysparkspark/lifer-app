import { rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { suggestSpecies, suggestSpeciesForFrames } from "@lifer/core/species/embeddings.js";
import { probeVideo, extractVideoFrame } from "@lifer/core/uploads/image.js";
import { uploadTempPath } from "../uploads/common.js";
import { claimedPhotoFormat, sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { prepareWorkingImage, type WorkingImage } from "../uploads/workingImage.js";
import { receiveToFile, stageUpload, sweepStagedUploads } from "../lib/stagedUploads.js";
import { finishedTusUpload } from "../lib/tusUploads.js";
import { withSchemas } from "../lib/schema.js";

// Both routes take multipart/form-data, read part by part from the stream, so there's no body
// schema: the handlers check the fields (`file`, `regionId`, `uploadId`) as they arrive.
export async function speciesSuggestRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Ranks candidate species for an unassigned photo, for the picker to offer. Never assigns.
  app.post("/captures/suggest-species", { preValidation: requireAuth, schema: {} }, async (request, reply) => {
    // Checked server side before any costly work, not only as a UI gate.
    const settingRes = await pool.query<{ species_suggest_enabled: boolean }>(
      `SELECT species_suggest_enabled FROM users WHERE id = $1`,
      [request.user!.id],
    );
    if (settingRes.rows[0]?.species_suggest_enabled === false) return { suggestions: [] };

    // Streamed to a temp file, so a HEIC or a huge panorama is matched on its working copy.
    let tmpPath: string | null = null;
    let claimed: { mimetype: string; filename: string } | null = null;
    let regionId: string | null = null;
    let working: WorkingImage | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file" && part.fieldname === "file" && !tmpPath) {
          tmpPath = await uploadTempPath(part.filename);
          await receiveToFile(part.file, tmpPath);
          claimed = { mimetype: part.mimetype, filename: part.filename };
        } else if (part.type === "file") {
          part.file.resume(); // not ours: drain it so the request can finish
        } else if (part.fieldname === "regionId") {
          regionId = String(part.value) || null;
        }
      }
      if (!tmpPath) return reply.code(400).send({ error: "No file uploaded" });

      try {
        const format = (await sniffPhotoFormat(tmpPath)) ?? claimedPhotoFormat(claimed?.mimetype, claimed?.filename);
        if (format) working = await prepareWorkingImage(tmpPath, format);
        const bytes = await readFile(working?.inferencePath ?? tmpPath);
        const suggestions = await suggestSpecies(pool, request.user!.id, bytes, regionId);
        return { suggestions };
      } catch (err) {
        // Usually the model isn't downloaded yet. Suggestions are optional, so return an empty list
        // (200) rather than an error.
        request.log.warn({ err }, "Species suggestion failed");
        return { suggestions: [], code: "suggestion_failed" };
      }
    } finally {
      await working?.release();
      if (tmpPath) await rm(tmpPath, { force: true });
    }
  });

  // Same for a video: several frames spread across the clip are sampled and the best match
  // decides.
  app.post(
    "/captures/suggest-species-from-video",
    { preValidation: requireAuth, schema: {} },
    async (request, reply) => {
      const settingRes = await pool.query<{ species_suggest_enabled: boolean }>(
        `SELECT species_suggest_enabled FROM users WHERE id = $1`,
        [request.user!.id],
      );
      if (settingRes.rows[0]?.species_suggest_enabled === false) return { suggestions: [] };

      // Streamed to a temp file (ffprobe and ffmpeg need a real path), cleaned up in `finally` unless
      // kept for the import. Or `uploadId`, a finished resumable upload read in place.
      const tmpPath = await uploadTempPath(null, ".suggest");
      let fingerprint: string | null = null;
      let regionId: string | null = null;
      let uploadId: string | null = null;
      for await (const part of request.parts()) {
        if (part.type === "file" && part.fieldname === "file" && !fingerprint) {
          ({ fingerprint } = await receiveToFile(part.file, tmpPath));
        } else if (part.type === "file") {
          part.file.resume(); // not ours: drain it so the request can finish
        } else if (part.fieldname === "regionId") {
          regionId = String(part.value) || null;
        } else if (part.fieldname === "uploadId") {
          uploadId = String(part.value) || null;
        }
      }
      let videoPath = tmpPath;
      if (fingerprint) uploadId = null;
      else if (uploadId) {
        const upload = await finishedTusUpload(request.user!.id, uploadId);
        if (!upload) return reply.code(410).send({ error: "That upload isn't here any more. Upload the file again." });
        videoPath = upload.path;
      } else return reply.code(400).send({ error: "No file uploaded" });

      // The video is kept for the import whether or not suggestions work out, so it isn't sent
      // twice. A resumable upload already is, under its uploadId.
      const keep = async () => {
        if (uploadId) return null;
        void sweepStagedUploads();
        return (await stageUpload(request.user!.id, fingerprint!, tmpPath)) ? fingerprint : null;
      };
      try {
        const { durationSeconds } = await probeVideo(videoPath);
        const duration = durationSeconds && durationSeconds > 0.5 ? durationSeconds : 1;
        // Up to 5 frames, one at a random point in each equal slice of the clip. Short clips get fewer.
        const frameCount = Math.max(1, Math.min(5, Math.floor(duration / 0.4)));
        const bucketSeconds = duration / frameCount;
        const timestamps = Array.from({ length: frameCount }, (_, i) => {
          const bucketStart = i * bucketSeconds;
          return bucketStart + Math.random() * bucketSeconds;
        });

        const frames: Buffer[] = [];
        for (const t of timestamps) {
          try {
            frames.push(await extractVideoFrame(videoPath, t));
          } catch {
            // One unreadable timestamp shouldn't sink the rest.
          }
        }
        // Still 200 (the web app reads stagedId either way); `error` distinguishes "couldn't read the
        // video" from "no species matched".
        if (frames.length === 0) {
          return {
            suggestions: [],
            error: "Couldn't read any frames from this video",
            code: "no_video_frames",
            stagedId: await keep(),
            uploadId,
          };
        }

        const suggestions = await suggestSpeciesForFrames(pool, request.user!.id, frames, regionId);
        return { suggestions, stagedId: await keep(), uploadId };
      } catch (err) {
        request.log.warn({ err }, "Video species suggestion failed");
        return {
          suggestions: [],
          error: "Couldn't analyze this video",
          code: "suggestion_failed",
          stagedId: await keep().catch(() => null),
          uploadId,
        };
      } finally {
        rmSync(tmpPath, { force: true });
      }
    },
  );
}
