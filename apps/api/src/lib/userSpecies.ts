import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

// A photo of a species marks it collected. Keeps an existing cover photo, and first_collected
// falls back to today for an undated photo.
export async function markCollected(
  db: Queryable,
  userId: string,
  speciesId: string,
  coverPhotoId: string | null,
  takenAt: Date | string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected)
     VALUES ($1, $2, 'collected', $3, COALESCE($4::date, CURRENT_DATE))
     ON CONFLICT (user_id, species_id) DO UPDATE SET
       state = 'collected',
       cover_photo_id = COALESCE(user_species.cover_photo_id, EXCLUDED.cover_photo_id)`,
    [userId, speciesId, coverPhotoId, takenAt],
  );
}
