// POST /uploads/identify-animal: ranks species again on one animal the user chose in a photo being
// imported (a numbered detector box or a box they drew in compare mode), and on the same spot in the
// other frames of its burst, so a photo with several animals or a wrong subject gets the right answer.
// Writes no rows: the import screen keeps the choice until the user confirms a species.
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { claimedPhotoFormat, isRawFile, sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import {
  photoVector,
  rankSpeciesByEmbeddings,
  suggestionVectorKind,
  WHOLE_KIND,
} from "@lifer/core/species/embeddings.js";
import { contentHash, type ImageSource } from "@lifer/core/species/inference.js";
import { requireScope } from "../auth/session.js";
import { replies, Uuid, withSchemas } from "../lib/schema.js";
import { finishedTusUpload } from "../lib/tusUploads.js";
import { burstMates } from "../species/bursts.js";
import { extractEmbeddedPreview, extractExif, readExifTags } from "./exif.js";
import { whileImporting } from "./preparedAhead.js";
import { AnimalIdentification } from "./responses.js";
import { prepareWorkingImage } from "./workingImage.js";

type PercentBox = { x: number; y: number; w: number; h: number };

const pct = (o: { minimum?: number; exclusiveMinimum?: number }) => Type.Number({ maximum: 100, ...o });
const Body = Type.Object({
  uploadId: Type.String({ minLength: 1, maxLength: 200, description: "The photo's finished resumable upload" }),
  regionId: Uuid({ description: "The region to rank for, as for POST /uploads/inspect" }),
  box: Type.Object(
    {
      x: pct({ minimum: 0 }),
      y: pct({ minimum: 0 }),
      w: pct({ exclusiveMinimum: 0 }),
      h: pct({ exclusiveMinimum: 0 }),
    },
    { description: "The animal, in percent of the upright photo" },
  ),
});

// The box as drawn and a looser view with more of the animal: a tight crop alone can lose the head
// or take in a branch, and either view can carry the match.
const VIEW_SCALES = [1, 1.6];
// The same margin the automatic subject crop leaves round the animal.
const PADDING = 0.125;
const MAX_SIDE = 1024;

/** The square around `box` scaled by `k`, in pixels of a `width` by `height` photo, kept inside it. */
export function squareAround(box: PercentBox, k: number, width: number, height: number) {
  const cx = ((box.x + box.w / 2) / 100) * width;
  const cy = ((box.y + box.h / 2) / 100) * height;
  const side = Math.max((box.w / 100) * width, (box.h / 100) * height) * (1 + 2 * PADDING) * k;
  const size = Math.max(1, Math.floor(Math.min(side, width, height)));
  return {
    left: Math.round(Math.min(Math.max(cx - size / 2, 0), width - size)),
    top: Math.round(Math.min(Math.max(cy - size / 2, 0), height - size)),
    width: size,
    height: size,
  };
}

async function cropViews(image: ImageSource, box: PercentBox): Promise<Buffer[]> {
  const input = image instanceof Uint8Array ? image : image.path;
  const meta = await sharp(input, originalSharpOptions()).metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  const width = (turned ? meta.height : meta.width) ?? 0;
  const height = (turned ? meta.width : meta.height) ?? 0;
  if (!width || !height) throw new Error("The photo couldn't be read");
  return Promise.all(
    VIEW_SCALES.map((k) =>
      sharp(input, originalSharpOptions())
        .rotate()
        .extract(squareAround(box, k, width, height))
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer(),
    ),
  );
}

/** A finished upload as matching reads it: a RAW's embedded preview, else a working copy (inspect.ts). */
async function openFrame(userId: string, uploadId: string) {
  const upload = await finishedTusUpload(userId, uploadId);
  if (!upload) return null;
  const exif = await extractExif(upload.path, await readExifTags(upload.path)).catch(() => null);
  const takenAt = exif?.localTakenAt ?? null;
  if (await isRawFile(upload.path, upload.filename ?? "")) {
    const preview = await extractEmbeddedPreview(upload.path);
    return preview
      ? { image: preview as ImageSource, key: contentHash(preview), takenAt, release: async () => {} }
      : null;
  }
  const format = (await sniffPhotoFormat(upload.path)) ?? claimedPhotoFormat(upload.filetype, upload.filename);
  if (!format) return null;
  const working = await prepareWorkingImage(upload.path, format);
  return { image: { path: working.inferencePath }, key: upload.sha256, takenAt, release: working.release };
}

export async function identifyAnimalRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.post(
    "/uploads/identify-animal",
    {
      preValidation: requireScope("photos.write", ["imports.write"]),
      schema: { body: Body, response: replies(AnimalIdentification) },
    },
    async (request, reply) =>
      whileImporting(async () => {
        const userId = request.user!.id;
        const { uploadId, regionId, box } = request.body;
        if (box.x + box.w > 100.5 || box.y + box.h > 100.5)
          return reply.code(400).send({ error: "The box runs off the photo." });
        const model = await suggestionVectorKind(pool).catch(() => null);
        if (!model)
          return reply.code(409).send({
            error: "Download the species-matching model in Settings to match an animal.",
            code: "models_not_ready",
          });

        const whole = WHOLE_KIND[model.kind];
        const boxKey = [box.x, box.y, box.w, box.h].map((v) => v.toFixed(2)).join(",");
        const vectors: Float32Array[] = [];
        const followed: string[] = [];
        let takenAt: Date | null = null;
        for (const id of [uploadId, ...burstMates(userId, uploadId)]) {
          const own = id === uploadId;
          const frame = await openFrame(userId, id).catch(() => null);
          if (!frame) {
            if (own) return reply.code(410).send({ error: "That upload isn't here any more. Add the photo again." });
            continue;
          }
          try {
            const views = await cropViews(frame.image, box);
            // Keyed by the photo and the box, so choosing the same animal again reuses the vectors.
            const found = await Promise.all(
              views.map((view, i) =>
                photoVector(whole, view, {
                  key: `${frame.key}:animal:${VIEW_SCALES[i]}:${boxKey}`,
                  priority: "interactive",
                }),
              ),
            );
            vectors.push(...found);
            if (own) takenAt = frame.takenAt;
            else followed.push(id);
          } catch (err) {
            // A burst frame that can't be read is left out; the chosen photo itself must match.
            if (own) throw err;
          } finally {
            await frame.release();
          }
        }

        const suggestions = await rankSpeciesByEmbeddings(pool, userId, vectors, regionId, 5, takenAt, model.space);
        return { suggestions, burst: followed.length > 0 ? { uploadIds: followed } : null };
      }),
  );
}
