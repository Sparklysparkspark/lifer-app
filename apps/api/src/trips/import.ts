// Commits one reviewed trip file to a real capture — the trip-scoped counterpart to
// uploads/routes.ts's mode=link branch. Deliberately its own simpler function rather than a
// shared extraction: trip photos are standalone JPEGs living wherever the user's own trip
// archive already organizes them (no store-mode folder writes to worry about), so the extra
// branching in the main upload route would only add risk without being exercised here. RAW
// sibling linking (rawLink.ts) IS shared in spirit — same filename-stem + timestamp rule as
// uploads/routes.ts's own auto-link — just its own small module rather than extracted from
// that route. The one piece that MUST stay identical either way — the fingerprint math —
// already is, via uploads/fileFingerprint.ts, used by both.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../db.js";
import { generateDerivatives } from "../uploads/image.js";
import { extractExif, readExifTags } from "../uploads/exif.js";
import { computeFileFingerprint } from "../uploads/fileFingerprint.js";
import { recordTripIndexEntry } from "./tripIndex.js";
import { linkRawForCapture } from "./rawLink.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";

export interface TripImportResult {
  captureId: string;
  photoId: string;
}

// sourceFolder/relativePath are only used to record the recovery index entry (tripIndex.ts) —
// not needed for the commit itself, which already has the file's real absolutePath.
export async function importTripFile(
  tripId: string,
  userId: string,
  speciesId: string,
  absolutePath: string,
  sourceFolder: string,
  relativePath: string,
): Promise<TripImportResult> {
  const speciesRes = await pool.query<{ id: string; scientific_name: string }>(`SELECT id, scientific_name FROM species WHERE id = $1`, [speciesId]);
  if (speciesRes.rows.length === 0) throw new Error("Unknown species");

  const tags = await readExifTags(absolutePath);
  const exif = await extractExif(absolutePath, tags);
  // Passes the already-read tags through — computeFileFingerprint would otherwise re-read
  // this same file's EXIF from scratch, a second exiftool round-trip per file that's exactly
  // what made a small trip import noticeably slow.
  const { contentHash, exifFingerprint } = await computeFileFingerprint(absolutePath, tags);
  const buffer = readFileSync(absolutePath);
  // Trip photos are the canonical reference-in-place case (see this file's own top comment) —
  // exactly what tagging against a registered external drive is for (see
  // ~/.claude/plans/multi-drive-storage.md). A path not under any registered volume resolves to
  // {volumeId: null, ...}, i.e. today's plain-absolute-path behavior, unchanged.
  const volumeTag = await tagWithRegisteredVolume(userId, absolutePath);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const captureRes = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, species_id, trip_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        userId,
        speciesId,
        tripId,
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
      ],
    );
    const captureId = captureRes.rows[0].id;

    const photoId = randomUUID();
    const { displayPath, thumbPath, width, height } = await generateDerivatives(buffer, photoId);
    const photoRes = await client.query<{ id: string }>(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [photoId, captureId, displayPath, thumbPath, width, height],
    );
    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoRes.rows[0].id, captureId]);

    // Same "this photo now counts as collected" behavior as a normal upload — a trip photo
    // is a real capture, not a lesser one just because the file stays where it already lived.
    await client.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
       VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
       ON CONFLICT (user_id, species_id) DO UPDATE SET
         state = 'collected',
         cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
      [userId, speciesId, photoRes.rows[0].id, exif.takenAt],
    );

    // managed=false, ref=the file's own real path — never copied, never renamed. See
    // originals.managed's own convention (uploads/routes.ts) for why this is the right value.
    await client.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, volume_id, volume_relative_path)
       VALUES ($1, 'jpeg', 'path', $2, false, $3, $4, $5, $6, $7, $8, $9)`,
      [
        captureId,
        absolutePath,
        contentHash,
        buffer.length,
        exifFingerprint.strict,
        exifFingerprint.loose,
        userId,
        volumeTag.volumeId,
        volumeTag.volumeRelativePath,
      ],
    );

    await client.query("COMMIT");
    // Best-effort — recorded after commit succeeds, and never allowed to fail the import
    // itself (see tripIndex.ts's own comment: losing a recovery entry just means one photo
    // needs manual reassignment after a future fresh install, not data loss now).
    recordTripIndexEntry(sourceFolder, relativePath, speciesRes.rows[0].scientific_name).catch(() => {});
    // Same best-effort spirit — a RAW sibling not linking on the first try just gets picked
    // up by the next rescan (scan.ts's autoLinkMissingRaws) instead of failing this import.
    try {
      await linkRawForCapture(captureId, path.basename(absolutePath), exif.takenAt, sourceFolder);
    } catch {
      // ignore — see comment above
    }
    return { captureId, photoId: photoRes.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
