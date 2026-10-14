// The one place captures and originals rows are inserted, so every import path (uploads, trips,
// the library reimport) fills the same columns the same way.
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
}

/** Inserts through the `captures` view, so the caller hides the capture last, if at all. */
export async function insertCapture(db: Queryable, c: CaptureInsert): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO captures
       (user_id, species_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon,
        camera_model, lens, focal_length_mm, aperture, shutter, iso, quality_rating, trip_id, region_id,
        location_label, cull_verdict, cull_label, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,COALESCE($21::text[], '{}'))
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
  kind: "jpeg" | "raw" | "video";
  ref: string;
  /** Lifer wrote or moved the file into its own layout, so it may move or rename it later. */
  managed: boolean;
  contentHash: string;
  fileSize: number;
  exifFingerprint?: FingerprintPair | null;
  volumeId?: string | null;
  volumeRelativePath?: string | null;
}

export async function insertOriginal(db: Queryable, o: OriginalInsert): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO originals
       (user_id, capture_id, species_id, kind, ref_type, ref, managed, content_hash, file_size,
        exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
     VALUES ($1,$2,$3,$4,'path',$5,$6,$7,$8,$9,$10,$11,$12)
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
    ],
  );
  return res.rows[0].id;
}
