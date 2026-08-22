import type { PhotoSource, PhotoSourceAsset } from "@lifer/shared";
import { pool } from "../db.js";

// The trivial implementation (7e) — wraps the same local-filesystem behavior every route
// already used before this abstraction existed, so nothing about today's default path
// changes; it's just expressed behind the interface now.
export class LocalPhotoSource implements PhotoSource {
  async listPhotos(speciesId: string): Promise<PhotoSourceAsset[]> {
    const res = await pool.query<{ id: string }>(
      `SELECT p.id FROM photos p JOIN captures c ON c.id = p.capture_id WHERE c.species_id = $1`,
      [speciesId],
    );
    return res.rows.map((r) => ({ id: r.id, url: `/api/photos/${r.id}/thumb` }));
  }

  async originalUrl(captureId: string): Promise<string | null> {
    const res = await pool.query<{ id: string }>(`SELECT id FROM photos WHERE capture_id = $1`, [captureId]);
    return res.rows[0] ? `/api/photos/${res.rows[0].id}/original` : null;
  }
}
