// A browsable gallery of every photo you've taken, across all species — separate from the
// per-species detail view, for just scrolling your own collection like a photo library.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/gallery", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;

    const res = await pool.query(
      `SELECT p.id AS photo_id, c.species_id, s.scientific_name, s.common_name, c.taken_at, c.created_at,
              c.camera_model, c.lens, c.focal_length_mm, c.aperture, c.shutter, c.iso
       FROM captures c
       JOIN photos p ON p.id = c.current_photo_id
       JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1
       ORDER BY c.taken_at DESC NULLS LAST, c.created_at DESC`,
      [userId],
    );

    return {
      items: res.rows.map((row) => ({
        photoId: row.photo_id,
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
      })),
    };
  });
}
