// POST /photos/:id/frame: saves one exact frame of a video as a new photo, at the video's full
// size and unadjusted. The frame is filed through the ordinary photo import, so it gets
// derivatives, a folder and the species like any other photo.
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { extractVideoFrame } from "@lifer/core/uploads/image.js";
import { IdParams, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { resolveOriginalPath } from "../storageVolumes/resolve.js";
import { uploadTempPath } from "./common.js";
import { writeVideoFrameMetadata } from "./exif.js";
import { importPhoto } from "./photo.js";
import { whileImporting } from "./preparedAhead.js";
import { UploadResponses } from "./responses.js";

interface VideoRow {
  species_id: string;
  region_id: string | null;
  trip_id: string | null;
  location_label: string | null;
  lat: string | null;
  lon: string | null;
  taken_at: Date | null;
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}

export async function videoFrameRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.post(
    "/photos/:id/frame",
    {
      preValidation: requireScope("photos.write"),
      config: notFoundOnInvalidId("No video for this photo"),
      schema: {
        params: IdParams,
        body: Type.Object({ atSeconds: Type.Number({ minimum: 0, maximum: 86_400 * 2 }) }),
        response: { ...replies(UploadResponses[201], 201), 200: UploadResponses[200] },
      },
    },
    async (request, reply) => {
      const row = (
        await pool.query<VideoRow>(
          `SELECT c.species_id, c.region_id, c.trip_id, c.location_label, c.lat, c.lon, c.taken_at,
                  o.ref, o.volume_id, o.volume_relative_path
             FROM photos p
             JOIN captures c ON c.id = p.capture_id
             JOIN originals o ON o.capture_id = c.id AND o.kind = 'video'
            WHERE p.id = $1 AND c.user_id = $2 AND p.kind = 'video'`,
          [request.params.id, request.user!.id],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "No video for this photo" });
      const original = await resolveOriginalPath(row);
      if (!original.connected || !original.path) {
        return reply.code(409).send({ error: "This video's drive isn't connected right now" });
      }
      const originalPath = original.path;
      const { atSeconds } = request.body;
      const jpeg = await extractVideoFrame(originalPath, atSeconds, true).catch(() => null);
      if (!jpeg || jpeg.length === 0) return reply.code(400).send({ error: "Couldn't read a frame at that time" });

      const tmp = await uploadTempPath("frame.jpg");
      try {
        await writeFile(tmp, jpeg);
        await writeVideoFrameMetadata(tmp, {
          takenAt: row.taken_at ? new Date(row.taken_at.getTime() + Math.round(atSeconds * 1000)) : null,
          lat: row.lat == null ? null : Number(row.lat),
          lon: row.lon == null ? null : Number(row.lon),
          sourceName: path.basename(originalPath),
        });
        const stem = path.basename(originalPath, path.extname(originalPath));
        const file = {
          path: tmp,
          filename: `${stem}-${atSeconds.toFixed(2)}s.jpg`,
          mimetype: "image/jpeg",
          sha256: createHash("sha256")
            .update(await readFile(tmp))
            .digest("hex"),
          size: (await stat(tmp)).size,
          origin: "multipart" as const,
          uploadId: null,
          finish: async () => {},
        };
        const fields: Record<string, string> = { speciesId: row.species_id };
        if (row.region_id) fields.regionId = row.region_id;
        if (row.trip_id) fields.tripId = row.trip_id;
        if (row.location_label) fields.locationLabel = row.location_label;
        const outcome = await whileImporting(() => importPhoto(request, fields, file, null, [file]));
        return reply.code(outcome.code).send(outcome.body as never);
      } finally {
        await rm(tmp, { force: true });
      }
    },
  );
}
