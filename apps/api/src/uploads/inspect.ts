// POST /uploads/inspect: reads a photo before anything is saved (capture time, keywords, likely
// duplicates, species suggestions) so the import screen can match it to a species. Writes no rows.
// The photo comes as a `file` part (streamed to disk) or as `uploadId`, a finished resumable
// upload that is read where it is and later imported by the same id.
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { pool } from "../db.js";
import { requireScope } from "../auth/session.js";
import { extractExif, extractKeywords, readExifTags, extractEmbeddedPreview } from "./exif.js";
import { claimedPhotoFormat, isRawFile, PHOTO_FORMATS, sniffPhotoFormat, type PhotoFormat } from "./formats.js";
import { stageUpload, sweepStagedUploads } from "../lib/stagedUploads.js";
import { finishedTusUpload } from "../lib/tusUploads.js";
import { originalSharpOptions } from "../lib/imageLimits.js";
import {
  findNearDuplicate,
  photoVectors,
  prefetchUserVectors,
  rememberClientVectors,
  rankSpeciesByEmbeddings,
  suggestionVectors,
  suggestSpecies,
  suggestionVectorKind,
  type SpeciesSuggestion,
} from "../species/embeddings.js";
import { contentHash, type ImageSource } from "../species/inference.js";
import { joinBurst, pooledVectors } from "../species/bursts.js";
import { matchSpeciesByKeywords, groupByScientificName } from "../species/matchByKeywords.js";
import { checkNotWildlife } from "../species/wildlifeCheck.js";
import { prepareWorkingImage, previewDataUrlFor, type WorkingImage } from "./workingImage.js";
import { receiveMultipartFile, type ReceivedFile } from "./uploadSource.js";

// The rare checks that need the photo's bytes in memory (the no-wildlife check's detector pass,
// the CLIP fallback for suggestions) read the file only up to this size, else a smaller copy.
const MAX_BYTES_IN_MEMORY = 64 * 1024 * 1024;

async function boundedBytes(filePath: string): Promise<Buffer> {
  if ((await stat(filePath)).size <= MAX_BYTES_IN_MEMORY) return readFile(filePath);
  return sharp(filePath, originalSharpOptions()).rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
}

export async function inspectUploadRoutes(app: FastifyInstance): Promise<void> {
  app.post("/uploads/inspect", { preHandler: requireScope("photos.write") }, async (request, reply) => {
    const userId = request.user!.id;
    let received: ReceivedFile | null = null;
    // Optional: with the batch's region, the same request also returns species suggestions from
    // the embedding the duplicate check computes anyway.
    let regionId: string | null = null;
    // Optional vectors the desktop app computed on its own machine (species/clientVectors.ts).
    let clientVectors: string | null = null;
    let uploadId: string | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (received) {
            part.file.resume();
            continue;
          }
          received = await receiveMultipartFile(part);
        } else if (part.fieldname === "regionId") regionId = String(part.value) || null;
        else if (part.fieldname === "clientVectors") clientVectors = String(part.value);
        else if (part.fieldname === "uploadId") uploadId = String(part.value) || null;
      }
    } catch (err) {
      await received?.finish(false);
      throw err;
    }

    // A resumable upload is inspected in place: nothing is moved, so the import can use it next.
    let file: { path: string; filename: string | null; mimetype: string | null; sha256: string };
    if (received) file = received;
    else if (uploadId) {
      const upload = await finishedTusUpload(userId, uploadId);
      if (!upload) return reply.code(410).send({ error: "That upload isn't here any more. Upload the file again." });
      file = { path: upload.path, filename: upload.filename, mimetype: upload.filetype, sha256: upload.sha256 };
    } else return reply.code(400).send({ error: "No file uploaded" });

    let working: WorkingImage | null = null;
    let kept = false;
    try {
      const isRaw = await isRawFile(file.path, file.filename ?? "");
      const format: PhotoFormat | null = isRaw ? null : ((await sniffPhotoFormat(file.path)) ?? claimedPhotoFormat(file.mimetype, file.filename));

      // Steps that don't depend on each other run at once: reading the EXIF, the duplicate
      // lookups (and loading your photos' vectors for them), and the models.
      const exifRead = readExifTags(file.path).then(async (tags) => ({ exif: await extractExif(file.path, tags), keywords: await extractKeywords(file.path, tags) }));
      exifRead.catch(() => {}); // awaited below, where a failure fails the request
      prefetchUserVectors(pool, userId);

      // The same content hash the commit stores on captures.fingerprint, so the client can offer
      // import-anyway or skip for a file you already have.
      const fingerprint = file.sha256;
      const [dupRes, embedSource] = await Promise.all([
        pool.query<{ capture_id: string; species_id: string; common_name: string | null; scientific_name: string; taken_at: string | null }>(
          `SELECT c.id AS capture_id, c.species_id, s.common_name, s.scientific_name, c.taken_at
           FROM captures c JOIN species s ON s.id = c.species_id
           WHERE c.user_id = $1 AND c.fingerprint = $2
           LIMIT 1`,
          [userId, fingerprint],
        ),
        // sharp can't decode camera RAW sensor data, so a RAW is matched on its embedded JPEG
        // preview. null means it has none: the checks below then find nothing. A HEIC or a huge
        // panorama is matched on a working copy (workingImage.ts).
        (async (): Promise<{ image: ImageSource; key: string; buffer: Buffer | null } | null> => {
          if (isRaw) {
            const preview = await extractEmbeddedPreview(file.path);
            return preview ? { image: preview, key: contentHash(preview), buffer: preview } : null;
          }
          if (!format) return null;
          working = await prepareWorkingImage(file.path, format);
          return { image: { path: working.inferencePath }, key: fingerprint, buffer: null };
        })().catch(() => null),
      ]);
      const workingImage = working as WorkingImage | null;
      // Client vectors are seeded first so both this check and the commit skip the models; only
      // valid when matching reads this very file, which is what the client computed them from.
      let usedClientVectors = false;
      if (clientVectors && workingImage?.inferenceIsOriginal) {
        const ignored = rememberClientVectors(clientVectors, fingerprint);
        if (ignored) request.log.debug({ reason: ignored }, "Ignored client-computed vectors");
        else usedClientVectors = true;
      }
      // How long this server took to run the models, so a desktop app can match wherever is faster.
      const matchStart = performance.now();
      let matchingMs: number | null = null;
      let embedBytes: Promise<Buffer> | null = null;
      const bytesForChecks = (): Promise<Buffer> =>
        (embedBytes ??= embedSource!.buffer ? Promise.resolve(embedSource!.buffer) : boundedBytes(workingImage!.inferencePath));

      let dup = dupRes.rows[0] as
        | { capture_id: string; species_id: string; common_name: string | null; scientific_name: string; taken_at: string | null }
        | undefined;
      let exactMatch = Boolean(dup);

      // One worker job computes both the whole-photo and cropped vectors, so the photo is decoded
      // once. The commit reuses both from memory.
      const suggestionModel = !dup && regionId && embedSource ? await suggestionVectorKind(pool).catch(() => null) : null;
      const photoKey = embedSource?.key ?? null;
      const analysis =
        !dup && embedSource
          ? photoVectors(embedSource.image, {
              key: photoKey,
              kinds: suggestionModel ? ["clip", suggestionModel.kind] : ["clip"],
              subject: !!suggestionModel,
              priority: "interactive",
            })
          : null;

      const { exif, keywords } = await exifRead;
      let embedding: Float32Array | null = null;

      // No identical file, so look for a visually near-identical one (a black-and-white
      // conversion, a re-export, a light crop) by embedding.
      if (analysis) {
        try {
          embedding = await analysis.vectors.clip;
          const near = await findNearDuplicate(pool, userId, embedding);
          if (near) {
            dup = near;
            exactMatch = false;
          }
        } catch {
          // Best effort: a failed embedding only means no near-duplicate is found.
        }
      }

      const possibleDuplicate = dup
        ? {
            captureId: dup.capture_id,
            speciesName: dup.common_name ?? dup.scientific_name,
            takenAt: dup.taken_at,
            exact: exactMatch,
          }
        : null;

      // A duplicate already has its answer, so suggestions aren't ranked for it.
      let suggestions: SpeciesSuggestion[] = [];
      // The other frames of this photo's burst, which the import screen gives the same ranking.
      let burst: { uploadIds: string[]; suggestions: SpeciesSuggestion[] } | null = null;
      if (!possibleDuplicate && regionId && embedSource && analysis && suggestionModel) {
        try {
          // The identification model when it's ready, CLIP otherwise: the subject crop, backed by
          // the whole photo when the detector was unsure, pooled with the rest of the burst.
          const vectors = await suggestionVectors(embedSource.image, suggestionModel.kind, { key: photoKey, priority: "interactive" });
          if (!usedClientVectors) matchingMs = Math.round(performance.now() - matchStart);
          const frames =
            uploadId && embedding && exif.takenAt
              ? joinBurst(userId, {
                  uploadId,
                  takenAt: exif.takenAt.getTime(),
                  clip: embedding,
                  vectors,
                  context: `${regionId}:${suggestionModel.space.modelVersion}`,
                })
              : null;
          // Frames are ordered by capture time, and photos aren't always checked in that order.
          const pooled = frames ? pooledVectors(frames.find((f) => f.uploadId === uploadId)!, frames) : vectors;
          suggestions = await rankSpeciesByEmbeddings(pool, userId, pooled, regionId, 5, exif.takenAt, suggestionModel.space);
          if (frames && frames.length > 1) burst = { uploadIds: frames.map((f) => f.uploadId).filter((id) => id !== uploadId), suggestions };
        } catch {
          // The identification model failing falls back to CLIP (suggestSpecies does that);
          // otherwise no suggestions rather than a failed request.
          suggestions = await bytesForChecks()
            .then((bytes) => suggestSpecies(pool, userId, bytes, regionId, 5, exif.takenAt, { key: photoKey ?? undefined }))
            .catch(() => []);
        }
      }

      // Keywords in the file that name exactly one species (common name, alias or synonym, the
      // same matching reimport.ts uses) are certain, so that species goes first with score 1.
      if (!possibleDuplicate && keywords.length > 0) {
        try {
          const matched = await matchSpeciesByKeywords(pool, keywords);
          const byName = groupByScientificName(matched);
          if (byName.size === 1) {
            const species = [...byName.values()][0][0];
            suggestions = [
              {
                id: species.id,
                scientific_name: species.scientific_name,
                common_name: species.common_name,
                score: 1,
                source: "keyword_tag",
              },
              ...suggestions.filter((s) => s.id !== species.id),
            ];
          }
        } catch {
          // Best effort, like the checks above.
        }
      }

      // A browser can't show a RAW, TIFF or HEIC, so a JPEG of it goes back as the import
      // screen's image: a RAW's embedded preview, else a small render of the photo.
      let previewDataUrl: string | null = null;
      if (isRaw && embedSource?.buffer) previewDataUrl = `data:image/jpeg;base64,${embedSource.buffer.toString("base64")}`;
      else if (format && workingImage && !PHOTO_FORMATS[format].browserViewable) previewDataUrl = await previewDataUrlFor(workingImage.decodePath).catch(() => null);

      // A multipart file is kept so the import can refer to it instead of sending it again
      // (lib/stagedUploads.ts). A resumable upload is already kept under its uploadId.
      void sweepStagedUploads();
      let stagedId: string | null = null;
      if (received) {
        kept = await stageUpload(userId, fingerprint, received.path);
        stagedId = kept ? fingerprint : null;
      }

      // A photo with no wildlife in it is flagged so the import screen leaves it out. Skipped for
      // duplicates and photos whose own keywords name a species.
      const notWildlife =
        !possibleDuplicate && embedSource && embedding && suggestions[0]?.source !== "keyword_tag"
          ? await bytesForChecks()
              .then((bytes) => checkNotWildlife(bytes, Array.from(embedding!)))
              .catch(() => null)
          : null;

      return {
        takenAt: exif.takenAt,
        keywords,
        possibleDuplicate,
        suggestions,
        burst,
        matchingMs,
        previewDataUrl,
        stagedId,
        uploadId: received ? null : uploadId,
        notWildlife,
      };
    } finally {
      await (working as WorkingImage | null)?.release();
      if (received && !kept) await received.finish(true);
    }
  });
}
