import { pool } from "@lifer/core/db.js";
import { albumItemRows } from "../albums/routes.js";
import type { LifeListEntry, PortfolioContent, PortfolioPhoto } from "./render.js";
import type { PortfolioSpec } from "./spec.js";

/** The portfolio's photos and life list for its owner. Only still images that aren't hidden or
 *  trashed; albums that aren't the owner's are skipped. */
export async function loadPortfolioContent(userId: string, spec: PortfolioSpec): Promise<PortfolioContent> {
  const photos = new Map<string, PortfolioPhoto>();
  for (const albumId of spec.albumIds) {
    const rows = await albumItemRows(albumId, userId).catch(() => []);
    for (const r of rows) {
      if (r.photo_kind !== "image" || r.hidden || photos.has(r.photo_id)) continue;
      photos.set(r.photo_id, {
        photoId: r.photo_id,
        width: r.width,
        height: r.height,
        commonName: r.common_name,
        scientificName: r.scientific_name,
      });
    }
  }
  if (spec.speciesIds.length > 0) {
    // The cover the owner chose, else the highest rated and newest.
    const best = await pool.query<{
      photo_id: string;
      width: number | null;
      height: number | null;
      common_name: string | null;
      scientific_name: string;
    }>(
      `SELECT DISTINCT ON (c.species_id) p.id AS photo_id, p.width, p.height, s.common_name, s.scientific_name
         FROM captures c
         JOIN photos p ON p.id = c.current_photo_id AND p.kind = 'image'
         JOIN species s ON s.id = c.species_id
         LEFT JOIN user_species us ON us.user_id = c.user_id AND us.species_id = c.species_id
        WHERE c.user_id = $1 AND c.species_id = ANY($2::uuid[]) AND c.hidden_at IS NULL
        ORDER BY c.species_id, (p.id = us.cover_photo_id) DESC, c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST`,
      [userId, spec.speciesIds],
    );
    for (const r of best.rows)
      if (!photos.has(r.photo_id))
        photos.set(r.photo_id, {
          photoId: r.photo_id,
          width: r.width,
          height: r.height,
          commonName: r.common_name,
          scientificName: r.scientific_name,
        });
  }
  let lifeList: LifeListEntry[] | null = null;
  if (spec.lifeList) {
    const res = await pool.query<{
      common_name: string | null;
      scientific_name: string;
      taxon_class: string | null;
      year: number | null;
    }>(
      `SELECT s.common_name, s.scientific_name, s.taxon_class, EXTRACT(YEAR FROM us.first_collected)::int AS year
         FROM user_species us JOIN species s ON s.id = us.species_id
        WHERE us.user_id = $1 AND us.state = 'collected'
        ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
      [userId],
    );
    lifeList = res.rows.map((r) => ({
      commonName: r.common_name,
      scientificName: r.scientific_name,
      taxonClass: r.taxon_class,
      year: r.year,
    }));
  }
  return { title: spec.title, photos: [...photos.values()], lifeList };
}
