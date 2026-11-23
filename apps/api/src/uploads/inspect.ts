// POST /uploads/inspect: reads a photo before anything is saved (capture time, keywords, likely
// duplicates, species suggestions) so the import screen can match it to a species. Writes no rows.
// The photo comes as a `file` part (streamed to disk) or as `uploadId`, a finished resumable
// upload that is read where it is and later imported by the same id.
import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { UploadInspection } from "./responses.js";
import {
  captureTimeFromTags,
  computeExifFingerprint,
  extractExif,
  extractKeywords,
  readExifTags,
  extractEmbeddedPreview,
} from "./exif.js";
import { findRawRelatedCaptures } from "./rawMatching.js";
import { findEditedVersionTarget } from "./versionGrouping.js";
import {
  claimedPhotoFormat,
  isRawFile,
  PHOTO_FORMATS,
  sniffPhotoFormat,
  type PhotoFormat,
} from "@lifer/core/uploads/formats.js";
import { stagedPath, stageUpload, sweepStagedUploads } from "../lib/stagedUploads.js";
import { prepareAhead, whileImporting } from "./preparedAhead.js";
import { finishedTusUpload } from "../lib/tusUploads.js";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import {
  findNearDuplicate,
  photoVectors,
  prefetchUserVectors,
  rememberClientVectors,
  rankSpeciesByEmbeddings,
  suggestionVectors,
  suggestSpecies,
  suggestionVectorKind,
  WHOLE_KIND,
  type SpeciesSuggestion,
} from "@lifer/core/species/embeddings.js";
import { analyzeImage, contentHash, SUBJECT_FRAMING_MIN, type ImageSource } from "@lifer/core/species/inference.js";
import { regionAt } from "../regions/regionAt.js";
import { nearestTown } from "../places/gazetteer.js";
import { joinBurst, pooledVectors } from "../species/bursts.js";
import { matchSpeciesByKeywords, groupByScientificName } from "../species/matchByKeywords.js";
import { checkSubject, unlessLikelyMatch, unsureWithoutAnimal, type SubjectCheck } from "../species/wildlifeCheck.js";
import { prepareWorkingImage, previewDataUrlFor, type WorkingImage } from "./workingImage.js";
import { receiveMultipartFile, type ReceivedFile } from "./uploadSource.js";
import { readCullMarks } from "./cullMarks.js";
import { log } from "@lifer/core/lib/log.js";

// A broken model fails every photo the same way, so the fallback is logged once per run.
let suggestionFallbackLogged = false;
function logSuggestionFallbackOnce(err: unknown): void {
  if (suggestionFallbackLogged) return;
  suggestionFallbackLogged = true;
  log.warn({ err }, "Species suggestions fell back to a simpler match (or none) because a model failed");
}

// The rare checks that need the photo's bytes in memory (the no-wildlife check's detector pass,
// the CLIP fallback for suggestions) read the file only up to this size, else a smaller copy.
const MAX_BYTES_IN_MEMORY = 64 * 1024 * 1024;

async function boundedBytes(filePath: string): Promise<Buffer> {
  if ((await stat(filePath)).size <= MAX_BYTES_IN_MEMORY) return readFile(filePath);
  return sharp(filePath, originalSharpOptions())
    .rotate()
    .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A detector box ([x1, y1, x2, y2] fractions of the upright photo) in percent, as the import screen draws it. */
export function subjectPercent(
  box: [number, number, number, number] | null,
): { x: number; y: number; w: number; h: number } | null {
  if (!box) return null;
  const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10;
  const [x1, y1, x2, y2] = box.map(pct);
  return x2 > x1 && y2 > y1
    ? { x: x1, y: y1, w: Math.round((x2 - x1) * 10) / 10, h: Math.round((y2 - y1) * 10) / 10 }
    : null;
}

export async function inspectUploadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Multipart: no body schema, the handler reads and checks each field as it streams in.
  app.post(
    "/uploads/inspect",
    { preValidation: requireScope("photos.write", ["imports.write"]), schema: { response: replies(UploadInspection) } },
    // Background previews (preparedAhead.ts) wait while photos are being checked.
    async (request, reply) =>
      whileImporting(async () => {
        const userId = request.user!.id;
        let received: ReceivedFile | null = null;
        // Optional: with the batch's region, the same request also returns species suggestions from
        // the embedding the duplicate check computes anyway.
        let regionId: string | null = null;
        // "1": rank with the region of the photo's own GPS point when it has one, else regionId.
        let cameraRegion = false;
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
            else if (part.fieldname === "cameraRegion") cameraRegion = String(part.value) === "1";
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
          if (!upload)
            return reply.code(410).send({ error: "That upload isn't here any more. Upload the file again." });
          file = { path: upload.path, filename: upload.filename, mimetype: upload.filetype, sha256: upload.sha256 };
        } else return reply.code(400).send({ error: "No file uploaded" });

        let working: WorkingImage | null = null;
        let kept = false;
        try {
          const isRaw = await isRawFile(file.path, file.filename ?? "");
          const format: PhotoFormat | null = isRaw
            ? null
            : ((await sniffPhotoFormat(file.path)) ?? claimedPhotoFormat(file.mimetype, file.filename));

          // Steps that don't depend on each other run at once: reading the EXIF, the duplicate
          // lookups (and loading your photos' vectors for them), and the models.
          const exifRead = readExifTags(file.path).then(async (tags) => ({
            tags,
            exif: await extractExif(file.path, tags),
            keywords: await extractKeywords(file.path, tags),
          }));
          exifRead.catch(() => {}); // awaited below, where a failure fails the request
          // What a culling app marked it, so the import screen can count and skip rejected photos.
          // Only the file's own metadata: a browser upload doesn't bring a sidecar along.
          const cullRead = readCullMarks(file.path);
          prefetchUserVectors(pool, userId);

          // The same content hash the commit stores on captures.fingerprint, so the client can offer
          // import-anyway or skip for a file you already have.
          const fingerprint = file.sha256;
          const [dupRes, embedSource] = await Promise.all([
            pool.query<{
              capture_id: string;
              species_id: string;
              common_name: string | null;
              scientific_name: string;
              taken_at: string | null;
            }>(
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
          // A RAW is matched on its embedded preview, so its vectors are keyed by the preview's hash
          // (the client extracted the same preview; the hash check in rememberClientVectors proves it).
          let usedClientVectors = false;
          const clientVectorKey = isRaw ? embedSource?.key : workingImage?.inferenceIsOriginal ? fingerprint : null;
          if (clientVectors && clientVectorKey) {
            const ignored = rememberClientVectors(clientVectors, clientVectorKey);
            if (ignored) request.log.debug({ reason: ignored }, "Ignored client-computed vectors");
            else usedClientVectors = true;
          }
          // How long this server took to run the models, so a desktop app can match wherever is faster.
          const matchStart = performance.now();
          let matchingMs: number | null = null;
          let embedBytes: Promise<Buffer> | null = null;
          const bytesForChecks = (): Promise<Buffer> =>
            (embedBytes ??= embedSource!.buffer
              ? Promise.resolve(embedSource!.buffer)
              : boundedBytes(workingImage!.inferencePath));

          let dup = dupRes.rows[0] as
            | {
                capture_id: string;
                species_id: string;
                common_name: string | null;
                scientific_name: string;
                taken_at: string | null;
              }
            | undefined;
          let exactMatch = Boolean(dup);

          // One worker job computes both the whole-photo and cropped vectors, so the photo is decoded
          // once. The commit reuses both from memory.
          const suggestionModel =
            !dup && regionId && embedSource ? await suggestionVectorKind(pool).catch(() => null) : null;
          const photoKey = embedSource?.key ?? null;
          const analysis =
            !dup && embedSource
              ? photoVectors(embedSource.image, {
                  key: photoKey,
                  kinds: suggestionModel ? ["clip", suggestionModel.kind, WHOLE_KIND[suggestionModel.kind]] : ["clip"],
                  subject: !!suggestionModel,
                  priority: "interactive",
                })
              : null;

          const { exif, keywords, tags } = await exifRead;
          // The camera's point, its region and nearest town (offline), looked up while the models run.
          const { lat, lon } = exif;
          const gpsRead =
            lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
              ? Promise.all([regionAt(lat, lon).catch(() => null), nearestTown(lat, lon).catch(() => null)]).then(
                  ([region, town]) => ({ lat, lon, regionId: region?.id ?? null, town: town?.name ?? null }),
                )
              : Promise.resolve(null);
          // A RAW of a photo you've already imported is filed with that photo on import (raw.ts), so it
          // already has its species: no suggestions, duplicate warning or wildlife check needed.
          const rawMatch = isRaw
            ? await findRawRelatedCaptures(
                userId,
                file.filename ?? "",
                exif,
                await computeExifFingerprint(file.path, tags),
                captureTimeFromTags(tags),
              )
                .then((matches) => (matches.length === 1 ? matches[0] : null))
                .catch(() => null)
            : null;
          // An edited JPEG of a RAW already imported joins that photo as a version on import, so
          // it has its species too. Only on the evidence that links versions on its own.
          const editedVersion =
            !isRaw && !dup
              ? await findEditedVersionTarget(
                  userId,
                  file.filename ?? "",
                  tags as Record<string, unknown>,
                  (await computeExifFingerprint(file.path, tags)).strict,
                ).catch(() => null)
              : null;
          const knownPhoto = Boolean(rawMatch || editedVersion);
          let embedding: Float32Array | null = null;

          // No identical file, so look for a visually near-identical one (a black-and-white
          // conversion, a re-export, a light crop) by embedding.
          if (analysis && !knownPhoto) {
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

          // With the earlier photo to show beside the new one, and its species, which "Import anyway"
          // takes as the match.
          const dupPhotoId = dup
            ? ((
                await pool.query<{ current_photo_id: string | null }>(
                  `SELECT current_photo_id FROM captures WHERE id = $1`,
                  [dup.capture_id],
                )
              ).rows[0]?.current_photo_id ?? null)
            : null;
          const possibleDuplicate = dup
            ? {
                captureId: dup.capture_id,
                photoId: dupPhotoId,
                speciesId: dup.species_id,
                speciesName: dup.common_name ?? dup.scientific_name,
                scientificName: dup.scientific_name,
                commonName: dup.common_name,
                takenAt: dup.taken_at,
                exact: exactMatch,
              }
            : null;

          // A duplicate already has its answer, so suggestions aren't ranked for it.
          let suggestions: SpeciesSuggestion[] = [];
          // The other frames of this photo's burst, which the import screen gives the same ranking.
          let burst: { uploadIds: string[]; suggestions: SpeciesSuggestion[] } | null = null;
          if (cameraRegion && regionId) regionId = (await gpsRead)?.regionId ?? regionId;
          if (!possibleDuplicate && !knownPhoto && regionId && embedSource && analysis && suggestionModel) {
            try {
              // The identification model when it's ready, CLIP otherwise: the subject crop and the
              // whole photo, pooled with the rest of the burst.
              const vectors = await suggestionVectors(embedSource.image, suggestionModel.kind, {
                key: photoKey,
                priority: "interactive",
              });
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
              const pooled = frames
                ? pooledVectors(
                    frames.find((f) => f.uploadId === uploadId)!,
                    frames,
                  )
                : vectors;
              suggestions = await rankSpeciesByEmbeddings(
                pool,
                userId,
                pooled,
                regionId,
                5,
                exif.localTakenAt,
                suggestionModel.space,
              );
              if (frames && frames.length > 1)
                burst = { uploadIds: frames.map((f) => f.uploadId).filter((id) => id !== uploadId), suggestions };
            } catch (err) {
              // The identification model failing falls back to CLIP (suggestSpecies does that);
              // otherwise no suggestions rather than a failed request.
              logSuggestionFallbackOnce(err);
              suggestions = await bytesForChecks()
                .then((bytes) =>
                  suggestSpecies(pool, userId, bytes, regionId, 5, exif.localTakenAt, { key: photoKey ?? undefined }),
                )
                .catch((fallbackErr) => {
                  logSuggestionFallbackOnce(fallbackErr);
                  return [];
                });
            }
          }

          // Where the animal sits, for the import screen's compare view. Only after matching ran the
          // detector here, so this reuses its detection; client vectors mean it never ran, so none.
          const subjectRead =
            suggestionModel && embedSource && !usedClientVectors
              ? analyzeImage(embedSource.image, {
                  targets: [],
                  key: photoKey,
                  frame: true,
                  priority: "interactive",
                }).then(
                  // A doubtful box (a weak guess, a flock, no animal found) shows the whole photo
                  // rather than zooming somewhere wrong.
                  (r) => (r.frame && r.frame.confidence >= SUBJECT_FRAMING_MIN ? subjectPercent(r.frame.box) : null),
                  () => null,
                )
              : Promise.resolve(null);

          // Keywords in the file that name exactly one species (common name, alias or synonym, the
          // same matching reimport.ts uses) are certain, so that species goes first with score 1.
          if (!possibleDuplicate && !knownPhoto && keywords.length > 0) {
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
          if (isRaw && embedSource?.buffer)
            previewDataUrl = `data:image/jpeg;base64,${embedSource.buffer.toString("base64")}`;
          else if (format && workingImage && !PHOTO_FORMATS[format].browserViewable)
            previewDataUrl = await previewDataUrlFor(workingImage.decodePath).catch(() => null);

          // A photo with no wildlife in it is flagged so the import screen leaves it out, and an insect
          // or spider is named so it can point to iNaturalist. Skipped for duplicates and photos whose
          // own keywords name a species.
          const subjectCheck: SubjectCheck =
            !possibleDuplicate && !knownPhoto && embedSource && embedding && suggestions[0]?.source !== "keyword_tag"
              ? await bytesForChecks()
                  .then((bytes) => checkSubject(bytes, Array.from(embedding!)))
                  .catch(() => ({ notWildlife: null, invertebrate: null, maybeNotWildlife: null }))
              : { notWildlife: null, invertebrate: null, maybeNotWildlife: null };
          const { notWildlife, invertebrate, maybeNotWildlife } = subjectCheck;
          if (invertebrate) suggestions = unlessLikelyMatch(suggestions);
          suggestions = unsureWithoutAnimal(suggestions, subjectCheck);

          // Staging moves the file, so it comes last, once nothing else reads it: the cull marks
          // read (started above, queued behind other exiftool reads) and the no-wildlife check both
          // open file.path, and a moved file reads as no marks and no verdict rather than an error.
          const cull = await cullRead;
          // The frame job may read the working image, which `finally` releases.
          const [subject, gps] = await Promise.all([subjectRead, gpsRead]);

          // A multipart file is kept so the import can refer to it instead of sending it again
          // (lib/stagedUploads.ts). A resumable upload is already kept under its uploadId.
          void sweepStagedUploads();
          let stagedId: string | null = null;
          if (received) {
            kept = await stageUpload(userId, fingerprint, received.path);
            stagedId = kept ? fingerprint : null;
          }
          // A photo headed for import gets its previews and card crop made while the user picks.
          const keptPath = received ? (kept ? stagedPath(userId, fingerprint) : null) : file.path;
          if (keptPath && format && !possibleDuplicate) prepareAhead(userId, fingerprint, keptPath, format);

          return {
            takenAt: exif.takenAt,
            // localTakenAt is the wall clock read as UTC, so its ISO form is that clock.
            cameraTime: exif.localTakenAt?.toISOString().slice(0, 19) ?? null,
            keywords,
            cull,
            possibleDuplicate,
            suggestions,
            burst,
            matchingMs,
            previewDataUrl,
            stagedId,
            uploadId: received ? null : uploadId,
            notWildlife,
            maybeNotWildlife: maybeNotWildlife ?? null,
            invertebrate,
            rawMatch: rawMatch && {
              captureId: rawMatch.id,
              speciesId: rawMatch.species_id,
              speciesName: rawMatch.common_name ?? rawMatch.scientific_name,
              scientificName: rawMatch.scientific_name,
              commonName: rawMatch.common_name,
            },
            editedVersionOf: editedVersion && {
              captureId: editedVersion.captureId,
              photoId: editedVersion.photoId,
              speciesId: editedVersion.speciesId,
              speciesName: editedVersion.commonName ?? editedVersion.scientificName,
              scientificName: editedVersion.scientificName,
              commonName: editedVersion.commonName,
              takenAt: editedVersion.takenAt,
            },
            subject,
            gps,
          };
        } finally {
          await (working as WorkingImage | null)?.release();
          if (received && !kept) await received.finish(true);
        }
      }),
  );
}
