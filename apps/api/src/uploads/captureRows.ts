// The one place captures and originals rows are inserted, so every import path (uploads, trips,
// the library reimport) fills the same columns the same way.
import { fingerprintFile } from "../movedPhotos/fingerprint.js";
import type { PoolClient } from "pg";
import type { CullMarks } from "@lifer/shared";
import type { ExtractedExif } from "./exif.js";

type Queryable = Pick<PoolClient, "query">;

type FingerprintPair = { strict: string | null; loose: string | null };

export interface CaptureInsert {
  userId: string;
  speciesId: string;
  /** The content hash the duplicate check compares. */
  fingerprint: string;
  /** Lets a RAW sibling indexed later find this capture (exif.ts). */
  exifFingerprint?: FingerprintPair | null;
  /** Capture time, GPS, camera settings and the file's own star rating. */
  exif: ExtractedExif;
  tripId?: string | null;
  regionId?: string | null;
  locationLabel?: string | null;
  /** Kept as the culling app left them, whatever the import did with them. */
  cull?: CullMarks | null;
  /** Photo tags Lifer wrote into the file earlier (reimport). */
  tags?: string[] | null;
  /** "suggested" when Lifer filed the species itself (captures/identification.ts); the default is the user's choice. */
  identificationState?: "suggested" | "confirmed";
  /** The match percentage a suggestion was filed with. */
  suggestionPercent?: number | null;
}

/** Inserts through the `captures` view, so the caller hides the capture last, if at all. */
export async function insertCapture(db: Queryable, c: CaptureInsert): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO captures
       (user_id, species_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon,
        camera_model, lens, focal_length_mm, aperture, shutter, iso, quality_rating, trip_id, region_id,
        location_label, cull_verdict, cull_label, tags, identification_state, suggestion_percent, taken_at_zoned)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,COALESCE($21::text[], '{}'),
        COALESCE($22, 'confirmed'), $23, $24)
     RETURNING id`,
    [
      c.userId,
      c.speciesId,
      c.fingerprint,
      c.exifFingerprint?.strict ?? null,
      c.exifFingerprint?.loose ?? null,
      c.exif.takenAt,
      c.exif.lat,
      c.exif.lon,
      c.exif.cameraModel,
      c.exif.lens,
      c.exif.focalLengthMm,
      c.exif.aperture,
      c.exif.shutter,
      c.exif.iso,
      c.exif.rating,
      c.tripId ?? null,
      c.regionId ?? null,
      c.locationLabel ?? null,
      c.cull?.verdict ?? null,
      c.cull?.label ?? null,
      c.tags ?? null,
      c.identificationState ?? null,
      c.suggestionPercent ?? null,
      c.exif.takenAtZoned ?? null,
    ],
  );
  return res.rows[0].id;
}

export interface OriginalInsert {
  /** Always set, linked or not, so ownership never depends on the capture join. */
  userId: string;
  /** Null for a RAW filed under a species without a capture yet. */
  captureId: string | null;
  /** Only for an unlinked RAW: the species it was filed under. */
  speciesId?: string | null;
  kind: "jpeg" | "raw" | "video" | "audio";
  ref: string;
  /** Lifer wrote or moved the file into its own layout, so it may move or rename it later. */
  managed: boolean;
  contentHash: string;
  fileSize: number;
  exifFingerprint?: FingerprintPair | null;
  volumeId?: string | null;
  volumeRelativePath?: string | null;
}

// When an import last added a file, so background file checks can wait for imports to finish.
export let lastOriginalInsertAt = 0;

export async function insertOriginal(db: Queryable, o: OriginalInsert): Promise<string> {
  // The archive health baseline: the hash just taken plus the file's mtime now. Lifer's own
  // metadata write afterwards bumps the mtime, so the first check quietly re-baselines.
  lastOriginalInsertAt = Date.now();
  // The moved-photos identity (movedPhotos/fingerprint.ts); a later metadata write refreshes it.
  const fp = await fingerprintFile(o.ref).catch(() => null);
  const mtime = fp?.mtime ?? null;
  const res = await db.query<{ id: string }>(
    `INSERT INTO originals
       (user_id, capture_id, species_id, kind, ref_type, ref, managed, content_hash, file_size,
        exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path,
        verified_hash, verified_mtime, checked_at, fp_quick_hash, fp_size, fp_mtime, fp_file_id,
        source_quick_hash)
     VALUES ($1,$2,$3,$4,'path',$5,$6,$7,$8,$9,$10,$11,$12,
        $7, $13::timestamptz, CASE WHEN $13::timestamptz IS NULL THEN NULL ELSE now() END,
        $14, $15, $13::timestamptz, $16, $14)
     RETURNING id`,
    [
      o.userId,
      o.captureId,
      o.speciesId ?? null,
      o.kind,
      o.ref,
      o.managed,
      o.contentHash,
      o.fileSize,
      o.exifFingerprint?.strict ?? null,
      o.exifFingerprint?.loose ?? null,
      o.volumeId ?? null,
      o.volumeRelativePath ?? null,
      mtime,
      fp?.quickHash ?? null,
      fp?.size ?? null,
      fp?.fileId ?? null,
    ],
  );
  return res.rows[0].id;
}
