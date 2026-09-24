// Orchestrates writeXmpSidecar (exif.ts) against every managed original a capture actually
// has — a capture's JPEG and RAW both get their own sidecar (unlike writeSpeciesMetadata's
// embedded write, which only ever touches the managed JPEG), each written next to whichever
// original file it belongs to. Called from every place that changes something this sidecar
// carries: species reassignment, rating, and species cover-photo selection.
import { pool } from "../db.js";
import { writeXmpSidecar, type SpeciesMetadata } from "./exif.js";

export async function syncCaptureXmpSidecars(userId: string, captureId: string): Promise<void> {
  const originalsRes = await pool.query<{ ref: string }>(
    `SELECT ref FROM originals WHERE capture_id = $1 AND managed = true AND ref_type = 'path'`,
    [captureId],
  );
  if (originalsRes.rows.length === 0) return;

  const captureRes = await pool.query<{
    quality_rating: number | null;
    taken_at: Date | null;
    lat: number | null;
    lon: number | null;
    camera_model: string | null;
    lens: string | null;
    focal_length_mm: string | null;
    aperture: string | null;
    shutter: string | null;
    iso: number | null;
    species_id: string;
    cover_photo_id: string | null;
  }>(
    `SELECT c.quality_rating, c.taken_at, c.lat, c.lon, c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso,
            c.species_id, us.cover_photo_id
     FROM captures c
     LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
     WHERE c.id = $1`,
    [captureId],
  );
  const capture = captureRes.rows[0];
  if (!capture) return;

  const isCover =
    capture.cover_photo_id != null &&
    (await pool.query(`SELECT 1 FROM photos WHERE id = $1 AND capture_id = $2`, [capture.cover_photo_id, captureId])).rowCount! > 0;

  const speciesRes = await pool.query<SpeciesMetadata>(
    `SELECT s.id, s.common_name AS "commonName", s.scientific_name AS "scientificName", s.taxon_class AS "taxonClass",
            s.taxon_order AS "taxonOrder", s.family, s.aba_code AS "abaCode", s.ebird_code AS "ebirdCode"
     FROM species s WHERE s.id = $1
     UNION ALL
     SELECT s.id, s.common_name AS "commonName", s.scientific_name AS "scientificName", s.taxon_class AS "taxonClass",
            s.taxon_order AS "taxonOrder", s.family, s.aba_code AS "abaCode", s.ebird_code AS "ebirdCode"
     FROM species s JOIN capture_species cs ON cs.species_id = s.id WHERE cs.capture_id = $2`,
    [capture.species_id, captureId],
  );
  const namingStyleRes = await pool.query<{ species_naming_styles: string[] }>(
    `SELECT species_naming_styles FROM users WHERE id = $1`,
    [userId],
  );

  const data = {
    species: speciesRes.rows,
    namingStyles: namingStyleRes.rows[0]?.species_naming_styles ?? [],
    rating: capture.quality_rating,
    isCover,
    takenAt: capture.taken_at,
    lat: capture.lat,
    lon: capture.lon,
    cameraModel: capture.camera_model,
    lens: capture.lens,
    focalLengthMm: capture.focal_length_mm != null ? Number(capture.focal_length_mm) : null,
    aperture: capture.aperture != null ? Number(capture.aperture) : null,
    shutter: capture.shutter,
    iso: capture.iso,
  };

  await Promise.all(originalsRes.rows.map((o) => writeXmpSidecar(o.ref, data).catch(() => {})));
}

// Best-effort variant for callers that shouldn't fail on a sidecar write, but where a failure
// should still show up in the logs instead of letting sidecars drift silently.
export async function syncCaptureXmpSidecarsLogged(userId: string, captureId: string): Promise<void> {
  try {
    await syncCaptureXmpSidecars(userId, captureId);
  } catch (err) {
    console.warn(`[xmp] Couldn't sync XMP sidecar for capture ${captureId}:`, err instanceof Error ? err.message : err);
  }
}
