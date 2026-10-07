// POST /uploads/video: store mode only. A video capture has the same rows as a photo capture: a
// photos row (kind='video', poster-frame stills) and an originals row (kind='video') holding the
// untouched file. Poster and transcode logic is in image.ts's generateVideoDerivatives.
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { APP_DATA_DIR, ORIGINALS_DIR } from "@lifer/core/config.js";
import { generateVideoDerivatives } from "@lifer/core/uploads/image.js";
import { captureTimeFromTags, extractExif, readExifTags, type CaptureTime, type ExtractedExif } from "./exif.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";
import { resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { claimStagedUpload, moveFile, receiveToFile } from "../lib/stagedUploads.js";
import { claimUploadById, isUploadSourceError, type ReceivedFile } from "./uploadSource.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { isUuid } from "../lib/validate.js";
import { withSchemas } from "../lib/schema.js";
import { markCollected } from "../lib/userSpecies.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { UPLOAD_TX_TIMEOUTS, derivativeFiles, moveIntoLibrary, originalFilename, removeFiles, uploadTmpDir, type ChosenVolume } from "./common.js";

const ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

// A resumable upload's type as the browser reported it, or from its name when it didn't know.
function videoMimetypeFor(mimetype: string | null, filename: string | null): string | null {
  if (mimetype && mimetype in ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE) return mimetype;
  const ext = filename ? path.extname(filename).toLowerCase() : "";
  return ext === ".mp4" ? "video/mp4" : ext === ".mov" ? "video/quicktime" : mimetype;
}

export async function videoUploadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Multipart: no body schema, the handler reads and checks each field as it streams in.
  app.post("/uploads/video", { preValidation: requireAuth, schema: {} }, async (request, reply) => {
    const fields: Record<string, string> = {};
    let fileMimetype: string | null = null;
    let fileName: string | null = null;
    // Streamed straight to a temp file (ffprobe, ffmpeg and exiftool all need a real path anyway),
    // never held in memory.
    const tmpDir = uploadTmpDir();
    await ensureDir(tmpDir);
    let tmpPath: string | null = null;
    let fingerprint: string | null = null;
    // A resumable upload used here (uploadId): kept for a retry when the import fails.
    let resumable: ReceivedFile | null = null;
    // Whatever way this request ends, the temp file goes with it (the video is moved into the
    // library before that).
    reply.raw.once("finish", () => {
      if (resumable) void resumable.finish(reply.statusCode < 400);
      else if (tmpPath) rmSync(tmpPath, { force: true });
    });
    for await (const part of request.parts()) {
      if (part.type === "file") {
        // One video per request; any other file part is drained, not left behind as a temp file.
        if (tmpPath) {
          part.file.resume();
          continue;
        }
        fileMimetype = part.mimetype;
        fileName = part.filename;
        tmpPath = path.join(tmpDir, `${randomUUID()}${ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE[part.mimetype] ?? ".upload"}`);
        ({ fingerprint } = await receiveToFile(part.file, tmpPath));
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    // The video was already sent: as a resumable upload (uploadId), or once to be checked for
    // species (stagedId). 410 when it's gone, so the app sends the file after all.
    if (!tmpPath && fields.uploadId) {
      try {
        resumable = await claimUploadById(request.user!.id, fields.uploadId);
      } catch (err) {
        if (isUploadSourceError(err)) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
      fileMimetype = videoMimetypeFor(fields.fileType || resumable.mimetype, fields.fileName || resumable.filename);
      fileName = fields.fileName || resumable.filename;
      // Moved to a temp name with the right extension (same folder tree, so a rename); moved
      // back if the import fails.
      const claimed = path.join(tmpDir, `${randomUUID()}${(fileMimetype && ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE[fileMimetype]) ?? ".upload"}`);
      await moveFile(resumable.path, claimed);
      const original = resumable.path;
      const finishResumable = resumable.finish;
      resumable = {
        ...resumable,
        path: claimed,
        finish: async (ok) => {
          if (!ok && existsSync(claimed)) await moveFile(claimed, original).catch(() => {});
          await finishResumable(ok);
        },
      };
      tmpPath = claimed;
      fingerprint = resumable.sha256;
    } else if (!tmpPath && fields.stagedId) {
      fileMimetype = fields.fileType || null;
      fileName = fields.fileName || null;
      const claimed = path.join(tmpDir, `${randomUUID()}${(fileMimetype && ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE[fileMimetype]) ?? ".upload"}`);
      if (!(await claimStagedUpload(request.user!.id, fields.stagedId, claimed))) {
        return reply.code(410).send({ error: "The checked copy of this video has expired. Send the file again." });
      }
      tmpPath = claimed;
      fingerprint = fields.stagedId;
    }

    const speciesId = fields.speciesId;
    if (!speciesId) return reply.code(400).send({ error: "speciesId field is required" });
    const regionId = fields.regionId || null;
    if (regionId !== null && !isUuid(regionId)) return reply.code(400).send({ error: "regionId must be a region id" });
    if (!isUuid(speciesId)) return reply.code(400).send({ error: "Unknown species" });
    if (fields.tripId && !isUuid(fields.tripId)) return reply.code(400).send({ error: "Unknown trip" });
    if (fields.albumId && !isUuid(fields.albumId)) return reply.code(400).send({ error: "Unknown album" });
    if (!tmpPath || !fingerprint) return reply.code(400).send({ error: "No file uploaded" });
    if (!fileMimetype || !(fileMimetype in ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE)) {
      return reply.code(400).send({ error: "Only MP4 or MOV video uploads are supported" });
    }
    const videoExtension = ACCEPTED_VIDEO_EXTENSION_BY_MIMETYPE[fileMimetype];

    let chosenVolume: ChosenVolume | null = null;
    if (fields.volumeId) {
      chosenVolume = isUuid(fields.volumeId) ? await resolveChosenVolumeDestination(request.user!.id, fields.volumeId) : null;
      if (!chosenVolume) return reply.code(400).send({ error: "That drive isn't connected right now" });
    }

    let tripBaseDir: string | null = null;
    let tripId: string | null = null;
    if (fields.tripId) {
      const tripRes = await pool.query<{ id: string; destination_folder: string }>(
        `SELECT id, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [fields.tripId, request.user!.id],
      );
      if (tripRes.rows.length === 0) return reply.code(400).send({ error: "Unknown trip" });
      tripBaseDir = tripRes.rows[0].destination_folder;
      tripId = tripRes.rows[0].id;
    }

    let albumId: string | null = null;
    if (fields.albumId) {
      const albumRes = await pool.query<{ id: string }>(`SELECT id FROM albums WHERE id = $1 AND user_id = $2`, [
        fields.albumId,
        request.user!.id,
      ]);
      if (albumRes.rows.length === 0) return reply.code(400).send({ error: "Unknown album" });
      albumId = albumRes.rows[0].id;
    }

    const speciesRes = await pool.query<{
      id: string;
      common_name: string | null;
      scientific_name: string;
      taxon_class: string | null;
      family: string | null;
      inat_iconic_taxon: string | null;
    }>(`SELECT id, common_name, scientific_name, taxon_class, family, inat_iconic_taxon FROM species WHERE id = $1`, [speciesId]);
    if (speciesRes.rows.length === 0) return reply.code(400).send({ error: "Unknown species" });
    const species = speciesRes.rows[0];

    let exif: ExtractedExif;
    let time: CaptureTime | null = null;
    try {
      // exiftool reads QuickTime/MP4 metadata too. The capture time is DateTimeOriginal, as for
      // photos (captureTimeFromTags); QuickTime's CreateDate isn't read. A video without those
      // tags or GPS just gets null takenAt/lat/lon.
      const tags = await readExifTags(tmpPath);
      exif = await extractExif(tmpPath, tags);
      time = captureTimeFromTags(tags);
    } catch {
      exif = { takenAt: null, lat: null, lon: null, cameraModel: null, lens: null, focalLengthMm: null, aperture: null, shutter: null, iso: null, rating: null };
    }

    const userId = request.user!.id;
    const { organizeByYear, organizeByLocation } = await getUserFileSettings(userId);
    const locationLabel = fields.locationLabel?.trim() || null;

    // The poster frame, any playback transcode and the copy into the library all happen before
    // the transaction opens: a transcode can take minutes and must not hold a pool connection.
    const written: string[] = [];
    const photoId = randomUUID();
    written.push(...derivativeFiles(photoId), path.join(APP_DATA_DIR, "video-preview", `${photoId}.mp4`));
    let derivatives: Awaited<ReturnType<typeof generateVideoDerivatives>>;
    let finalRef: string | null = null;
    const fileSize = (await stat(tmpPath)).size;
    // The library copy is the upload itself, moved (a rename on the same drive); a failed import
    // moves it back, and the end of the request removes it or keeps a resumable upload.
    const moveBack = async () => {
      if (finalRef && existsSync(finalRef)) await moveFile(finalRef, tmpPath!).catch(() => rmSync(finalRef!, { force: true }));
    };
    try {
      derivatives = await generateVideoDerivatives(tmpPath, photoId);
      const folder = originalsFolder(tripBaseDir ?? chosenVolume?.baseDir ?? ORIGINALS_DIR, {
        organizeByYear,
        organizeByLocation,
        locationLabel,
        speciesFolderName: await resolveSpeciesFolderName(userId, species.id),
        taxonClass: species.taxon_class,
        inatIconicTaxon: species.inat_iconic_taxon,
        namingStyles: [],
        takenAt: exif.takenAt,
        takenAtWallClock: time?.wallClock,
        subfolder: "Video",
      });
      finalRef = await moveIntoLibrary(tmpPath, folder, originalFilename(fileName, time, videoExtension));
    } catch (err) {
      removeFiles(written);
      await moveBack();
      throw err;
    }
    const filedRef = finalRef;
    const { displayPath, thumbPath, width, height, durationSeconds, previewPath } = derivatives;
    const volumeTag = chosenVolume
      ? { volumeId: chosenVolume.volumeId, volumeRelativePath: filedRef.slice(chosenVolume.mountPath.length) }
      : { volumeId: null, volumeRelativePath: null };

    const client = await pool.connect();
    let captureId: string;
    try {
      await client.query("BEGIN");
      await client.query(UPLOAD_TX_TIMEOUTS);

      const captureRes = await client.query<{ id: string }>(
        `INSERT INTO captures
           (user_id, species_id, fingerprint, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso, trip_id, region_id, location_label, quality_rating)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          userId,
          speciesId,
          fingerprint,
          exif.takenAt,
          exif.lat,
          exif.lon,
          exif.cameraModel,
          exif.lens,
          exif.focalLengthMm,
          exif.aperture,
          exif.shutter,
          exif.iso,
          tripId,
          regionId,
          locationLabel,
          exif.rating,
        ],
      );
      captureId = captureRes.rows[0].id;

      await client.query(
        `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height, kind, duration_seconds, preview_path)
         VALUES ($1,$2,$3,$4,$5,$6,'video',$7,$8)`,
        [photoId, captureId, displayPath, thumbPath, width, height, durationSeconds, previewPath],
      );

      await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);

      await markCollected(client, userId, speciesId, photoId, exif.takenAt);

      await client.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, volume_id, volume_relative_path)
         VALUES ($1, 'video', 'path', $2, true, $3, $4, $5, $6)`,
        [captureId, filedRef, fingerprint, fileSize, volumeTag.volumeId, volumeTag.volumeRelativePath],
      );

      if (albumId) {
        await client.query(
          `INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [albumId, captureId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      removeFiles(written);
      await moveBack();
      throw err;
    } finally {
      client.release();
    }
    // This photo may just have become the species' cover: frame the card on the animal.
    ensureDefaultCardCropLater(userId, speciesId);
    return reply.code(201).send({ captureId, photoId });
  });
}
