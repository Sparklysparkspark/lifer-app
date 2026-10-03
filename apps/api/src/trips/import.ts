// Commits one reviewed trip file as a capture, referencing the file in place.
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../db.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { generateDerivatives } from "../uploads/image.js";
import { extractExif, readExifTags } from "../uploads/exif.js";
import { computeFileFingerprint } from "../uploads/fileFingerprint.js";
import { recordTripIndexEntry } from "./tripIndex.js";
import { linkRawForCapture, stemOf, type RawCandidate } from "./rawLink.js";
import { originalsFolder } from "../uploads/organizedPath.js";
import { resolveSpeciesFolderName } from "../uploads/speciesFolderName.js";
import { copyToNewFile } from "../lib/safeFs.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";
import { markCollected } from "../lib/userSpecies.js";

export interface TripImportResult {
  captureId: string;
  photoId: string;
}

// sourceFolder/relativePath are only used for the recovery index entry (tripIndex.ts).
export async function importTripFile(
  tripId: string,
  userId: string,
  speciesId: string,
  absolutePath: string,
  sourceFolder: string,
  relativePath: string,
  // One region picked for the whole import batch, as in the upload flow.
  regionId: string | null,
  // true for the sorted copy Lifer made in the trip's destination folder (importInboxFile): Lifer
  // wrote it, so it's Lifer's to manage. false for a file linked where it already was.
  managed = false,
): Promise<TripImportResult> {
  const speciesRes = await pool.query<{ id: string; scientific_name: string }>(`SELECT id, scientific_name FROM species WHERE id = $1`, [speciesId]);
  if (speciesRes.rows.length === 0) throw new Error("Unknown species");

  const tags = await readExifTags(absolutePath);
  const exif = await extractExif(absolutePath, tags);
  // Reuses the tags already read, saving a second exiftool round trip per file.
  const { contentHash, exifFingerprint } = await computeFileFingerprint(absolutePath, tags);
  // The size only: derivatives are made from the path (uploads/image.ts decodes HEIC from it).
  const fileSize = statSync(absolutePath).size;
  // Tags the path against a registered drive; outside any volume it stays a plain absolute path.
  const volumeTag = await tagWithRegisteredVolume(userId, absolutePath);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const captureRes = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, species_id, trip_id, region_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso, quality_rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        userId,
        speciesId,
        tripId,
        regionId,
        contentHash,
        exifFingerprint.strict,
        exifFingerprint.loose,
        exif.takenAt,
        exif.lat,
        exif.lon,
        exif.cameraModel,
        exif.lens,
        exif.focalLengthMm,
        exif.aperture,
        exif.shutter,
        exif.iso,
        exif.rating,
      ],
    );
    const captureId = captureRes.rows[0].id;

    const photoId = randomUUID();
    const { displayPath, thumbPath, width, height } = await generateDerivatives(absolutePath, photoId);
    const photoRes = await client.query<{ id: string }>(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [photoId, captureId, displayPath, thumbPath, width, height],
    );
    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoRes.rows[0].id, captureId]);

    // A trip photo counts as collected like any upload, even though the file stays in place.
    await markCollected(client, userId, speciesId, photoRes.rows[0].id, exif.takenAt);

    await client.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, volume_id, volume_relative_path)
       VALUES ($1, 'jpeg', 'path', $2, $10, $3, $4, $5, $6, $7, $8, $9)`,
      [
        captureId,
        absolutePath,
        contentHash,
        fileSize,
        exifFingerprint.strict,
        exifFingerprint.loose,
        userId,
        volumeTag.volumeId,
        volumeTag.volumeRelativePath,
        managed,
      ],
    );

    await client.query("COMMIT");
    // This photo may just have become the species' cover: frame the card on the animal.
    ensureDefaultCardCropLater(userId, speciesId);
    // Best effort, after commit: a lost index entry only costs a manual reassignment later.
    recordTripIndexEntry(sourceFolder, relativePath, speciesRes.rows[0].scientific_name).catch(() => {});
    // Best effort too: an unlinked RAW is picked up by the next rescan.
    try {
      await linkRawForCapture(captureId, path.basename(absolutePath), exif.takenAt, sourceFolder);
    } catch {
    }
    return { captureId, photoId: photoRes.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Imports one photo from the trip's source folder: copies it into the destination folder,
 * sorted (<destination>/<taxon>/<species>/Adjusted, plus the year/location layers the user's
 * settings ask for), brings its RAW along (same stem, same capture time: the rule uploads and the
 * reimport use), then links the copy as the trip's photo. The source file is never touched.
 * `sourceRaws` is the source folder's RAW listing, read once per import job. */
export async function importInboxFile(
  tripId: string,
  userId: string,
  speciesId: string,
  sourceAbsolutePath: string,
  destinationFolder: string,
  regionId: string | null,
  sourceRaws: RawCandidate[],
): Promise<TripImportResult> {
  const speciesRes = await pool.query<{ taxon_class: string | null; inat_iconic_taxon: string | null }>(
    `SELECT taxon_class, inat_iconic_taxon FROM species WHERE id = $1`,
    [speciesId],
  );
  if (speciesRes.rows.length === 0) throw new Error("Unknown species");
  const prefs = (
    await pool.query<{ organize_originals_by_year: boolean; species_naming_styles: string[] | null }>(
      `SELECT organize_originals_by_year, species_naming_styles FROM users WHERE id = $1`,
      [userId],
    )
  ).rows[0];
  const tags = await readExifTags(sourceAbsolutePath);
  const exif = await extractExif(sourceAbsolutePath, tags);
  const folderOpts = {
    organizeByYear: prefs?.organize_originals_by_year ?? false,
    speciesFolderName: await resolveSpeciesFolderName(userId, speciesId),
    taxonClass: speciesRes.rows[0].taxon_class,
    inatIconicTaxon: speciesRes.rows[0].inat_iconic_taxon,
    namingStyles: prefs?.species_naming_styles ?? [],
    takenAt: exif.takenAt,
  };
  const adjustedDir = originalsFolder(destinationFolder, { ...folderOpts, subfolder: "Adjusted" });
  const copy = await copyToNewFile(adjustedDir, path.basename(sourceAbsolutePath), sourceAbsolutePath);

  // The RAW goes first, so importTripFile's own RAW linking finds it next to the copy.
  const raw = matchingSourceRaw(sourceAbsolutePath, sourceRaws);
  let rawCopy: string | null = null;
  if (raw) {
    const rawDir = originalsFolder(destinationFolder, { ...folderOpts, subfolder: "RAW" });
    rawCopy = await copyToNewFile(rawDir, path.basename(raw.absolutePath), raw.absolutePath).catch(() => null);
  }
  try {
    const result = await importTripFile(tripId, userId, speciesId, copy, destinationFolder, path.relative(destinationFolder, copy), regionId, true);
    // Lifer made the RAW copy too, so it's Lifer's to manage like the photo (rawLink.ts links
    // RAWs as the user's own files).
    if (rawCopy) {
      await pool.query(`UPDATE originals SET managed = true WHERE capture_id = $1 AND kind = 'raw'`, [result.captureId]).catch(() => {});
    }
    return result;
  } catch (err) {
    // Nothing links to the copies if the import failed: remove them rather than leave stray files.
    await rm(copy, { force: true }).catch(() => {});
    if (rawCopy) await rm(rawCopy, { force: true }).catch(() => {});
    throw err;
  }
}

/** The source folder's RAW for a photo: the same file stem (case-insensitive). When several
 * RAWs share it (two cards, two cameras), only one in the photo's own folder is trusted. */
function matchingSourceRaw(photoPath: string, sourceRaws: RawCandidate[]): RawCandidate | null {
  const stem = stemOf(path.basename(photoPath));
  const sameStem = sourceRaws.filter((r) => stemOf(path.basename(r.absolutePath)) === stem);
  if (sameStem.length === 1) return sameStem[0];
  if (sameStem.length > 1) {
    const sameFolder = sameStem.filter((r) => path.dirname(r.absolutePath) === path.dirname(photoPath));
    if (sameFolder.length === 1) return sameFolder[0];
  }
  return null;
}
