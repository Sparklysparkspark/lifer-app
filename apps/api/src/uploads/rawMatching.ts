// Finds which already-imported JPEG capture a RAW file belongs to: by filename stem verified
// against the capture time, then by EXIF fingerprint (strict, then loose).
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import type { CaptureTime, ExifFingerprint, ExtractedExif } from "./exif.js";
import { sanitizeUploadName } from "./common.js";

export type RawCaptureMatch = {
  /** The capture's id. Its species is species_id. */
  id: string;
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  trip_folder: string | null;
  location_label: string | null;
};

// A RAW and its JPEG usually share a base filename, but "DSC_0001" recurs across cards, so a name
// match only counts when the RAW's capture time matches the capture's stored taken_at.
// `legacyTakenAt`: the older zone-dependent reading (exif.ts), which earlier captures may carry.
async function findRawFilenameMatch(
  userId: string,
  rawFileName: string,
  takenAt: Date | null,
  legacyTakenAt: Date | null = null,
): Promise<RawCaptureMatch | null> {
  if (!takenAt) return null;
  const rawStem = sanitizeUploadName(path.basename(rawFileName, path.extname(rawFileName))).toLowerCase();
  if (!rawStem) return null;
  // The stem comparison runs in the query (directory, extension and any "-2" suffix stripped from
  // the stored ref), so only an actual match comes back.
  const candidates = await pool.query<RawCaptureMatch & { taken_at: Date | null }>(
    `SELECT c.id, c.species_id, s.common_name, s.scientific_name, s.taxon_class, c.taken_at, t.destination_folder AS trip_folder, c.location_label
     FROM captures c
     JOIN species s ON s.id = c.species_id
     JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     LEFT JOIN trips t ON t.id = c.trip_id
     WHERE c.user_id = $1
       AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')
       AND lower(regexp_replace(regexp_replace(o.ref, '^.*/', ''), '(-[0-9]+)?\\.[^.]+$', '')) = $2`,
    [userId, rawStem],
  );
  if (candidates.rows.length !== 1) return null;
  const match = candidates.rows[0];
  if (!match.taken_at) return null;
  const stored = new Date(match.taken_at).getTime();
  const close = (t: Date | null) => t != null && Math.abs(stored - t.getTime()) <= 1000;
  return close(takenAt) || close(legacyTakenAt) ? match : null;
}

// An exported JPEG often loses SubSecTimeOriginal/SerialNumber, so the loose fingerprint is the
// fallback when the strict one finds nothing (exif.ts).
async function findRawFingerprintMatches(
  userId: string,
  column: "exif_fingerprint" | "exif_fingerprint_loose",
  value: string,
) {
  return pool.query<RawCaptureMatch>(
    `SELECT c.id, c.species_id, s.common_name, s.scientific_name, s.taxon_class, t.destination_folder AS trip_folder, c.location_label
     FROM captures c JOIN species s ON s.id = c.species_id
     LEFT JOIN trips t ON t.id = c.trip_id
     WHERE c.user_id = $1 AND c.${column} = $2
       AND NOT EXISTS (SELECT 1 FROM originals o WHERE o.capture_id = c.id AND o.kind = 'raw')`,
    [userId, value],
  );
}

/** Captures without a RAW yet that this RAW could belong to. One entry is a confident match;
 *  several are ambiguous and left alone by callers. */
export async function findRawRelatedCaptures(
  userId: string,
  rawFileName: string,
  exif: ExtractedExif,
  fingerprint: ExifFingerprint,
  time: CaptureTime | null,
): Promise<RawCaptureMatch[]> {
  const filenameMatch = await findRawFilenameMatch(userId, rawFileName, exif.takenAt, time?.legacyTakenAt ?? null);
  if (filenameMatch) return [filenameMatch];
  // The current pair first, then the legacy zone-dependent pair (only differs outside UTC).
  const pairs = [
    { strict: fingerprint.strict, loose: fingerprint.loose },
    ...(fingerprint.legacy ? [fingerprint.legacy] : []),
  ];
  for (const pair of pairs) {
    let matches =
      pair.strict != null ? (await findRawFingerprintMatches(userId, "exif_fingerprint", pair.strict)).rows : [];
    if (matches.length === 0 && pair.loose != null) {
      matches = (await findRawFingerprintMatches(userId, "exif_fingerprint_loose", pair.loose)).rows;
    }
    if (matches.length > 0) return matches;
  }
  return [];
}
