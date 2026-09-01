// A browsable gallery of every photo you've taken, across all species — separate from the
// per-species detail view, for just scrolling your own collection like a photo library.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { onlyTopRated?: string; onlyFeatured?: string } }>(
    "/gallery",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.user!.id;
      const onlyTopRated = request.query.onlyTopRated === "1";
      const onlyFeatured = request.query.onlyFeatured === "1";

      // "Featured" compares this photo's id against user_species.cover_photo_id for the SAME
      // species — a per-species single pick (set from either SpeciesDetailPage.tsx or this
      // page's own toggle, via PATCH /species/:id/cover), not a photo-level flag of its own.
      const res = await pool.query(
        `SELECT c.id AS capture_id, p.id AS photo_id, p.width, p.height, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.created_at,
                c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso, c.quality_rating,
                (p.id = us.cover_photo_id) AS is_featured,
                EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw') AS has_raw_original
         FROM captures c
         JOIN photos p ON p.id = c.current_photo_id
         JOIN species s ON s.id = c.species_id
         LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
         WHERE c.user_id = $1
           ${onlyTopRated ? "AND c.quality_rating = 5" : ""}
           ${onlyFeatured ? "AND p.id = us.cover_photo_id" : ""}
         ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
        [userId],
      );

      return {
        items: res.rows.map((row) => ({
          photoId: row.photo_id,
          width: row.width,
          height: row.height,
          captureId: row.capture_id,
          speciesId: row.species_id,
          scientificName: row.scientific_name,
          commonName: row.common_name,
          takenAt: row.taken_at,
          cameraModel: row.camera_model,
          lens: row.lens,
          focalLengthMm: row.focal_length_mm,
          aperture: row.aperture,
          shutter: row.shutter,
          iso: row.iso,
          qualityRating: row.quality_rating,
          isFeatured: row.is_featured,
          hasRawOriginal: row.has_raw_original,
        })),
      };
    },
  );
}
