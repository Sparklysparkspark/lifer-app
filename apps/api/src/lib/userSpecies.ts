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

// A species' fallback cover: its best remaining photo, highest rated then newest (the same pick
// as replaceUnshowableCover in photos/routes.ts). Photos where it's only a secondary tag come
// last. Reads the `captures` view, so trashed captures never qualify.
const BEST_REMAINING_PHOTO_SQL = `(
  SELECT b.photo_id FROM (
    SELECT c.current_photo_id AS photo_id, 0 AS secondary, c.quality_rating, c.taken_at, c.id
    FROM captures c
    WHERE c.user_id = us.user_id AND c.species_id = us.species_id AND c.current_photo_id IS NOT NULL
    UNION ALL
    SELECT c.current_photo_id, 1, c.quality_rating, c.taken_at, c.id
    FROM capture_species cs JOIN captures c ON c.id = cs.capture_id
    WHERE cs.species_id = us.species_id AND c.user_id = us.user_id AND c.current_photo_id IS NOT NULL
  ) b
  ORDER BY b.secondary, b.quality_rating DESC NULLS LAST, b.taken_at DESC NULLS LAST, b.id
  LIMIT 1
)`;

/** Run after trashing captures: a species whose cover (its featured photo) is one of theirs moves
 *  to its best remaining photo, with the crop cleared since it was framed for the old one. With
 *  nothing left the cover is cleared and the species keeps its state, so a restore can bring it
 *  back. Returns the species that got a new cover photo, for the caller to frame after COMMIT. */
export async function repointCoversOffTrashedCaptures(
  db: Queryable,
  userId: string,
  captureIds: string[],
): Promise<string[]> {
  if (captureIds.length === 0) return [];
  const res = await db.query<{ species_id: string; cover_photo_id: string | null }>(
    `UPDATE user_species us SET cover_photo_id = ${BEST_REMAINING_PHOTO_SQL},
       card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
     FROM photos p
     WHERE us.user_id = $1 AND p.id = us.cover_photo_id AND p.capture_id = ANY($2::uuid[])
     RETURNING us.species_id, us.cover_photo_id`,
    [userId, captureIds],
  );
  return res.rows.filter((r) => r.cover_photo_id != null).map((r) => r.species_id);
}

/** Run after restoring a capture from the trash: a species left with no cover because all its
 *  photos were trashed gets its best photo back. A species that still had other photos keeps
 *  its cover, or its lack of one if the user un-featured it. Returns the species that got one. */
export async function restoreCoversForCapture(db: Queryable, userId: string, captureId: string): Promise<string[]> {
  const res = await db.query<{ species_id: string; cover_photo_id: string | null }>(
    `UPDATE user_species us SET cover_photo_id = ${BEST_REMAINING_PHOTO_SQL},
       card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
     WHERE us.user_id = $1 AND us.state = 'collected' AND us.cover_photo_id IS NULL
       AND us.species_id IN (
         SELECT species_id FROM captures WHERE id = $2
         UNION SELECT species_id FROM capture_species WHERE capture_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM captures o WHERE o.user_id = $1 AND o.species_id = us.species_id AND o.id <> $2
       )
     RETURNING us.species_id, us.cover_photo_id`,
    [userId, captureId],
  );
  return res.rows.filter((r) => r.cover_photo_id != null).map((r) => r.species_id);
}

/** Keeps "collected" in step with the photos you can see, for the species of `captureIds`: a
 *  species whose last photo went to the Trash stops counting as collected, and one whose photo came
 *  back from it counts again. Reads the `captures` view, which hides trashed captures; a photo
 *  where the species is a secondary tag counts too. Run after trashing or restoring. */
export async function syncCollectedState(db: Queryable, userId: string, captureIds: string[]): Promise<void> {
  if (captureIds.length === 0) return;
  await db.query(
    `WITH affected AS (
       SELECT species_id FROM captures_all WHERE id = ANY($2::uuid[])
       UNION SELECT species_id FROM capture_species WHERE capture_id = ANY($2::uuid[])
     )
     UPDATE user_species us
        SET state = CASE WHEN has_photo THEN 'collected' END
       FROM (
         SELECT a.species_id,
                EXISTS (SELECT 1 FROM captures c WHERE c.user_id = $1 AND c.species_id = a.species_id)
             OR EXISTS (SELECT 1 FROM capture_species cs JOIN captures c ON c.id = cs.capture_id
                         WHERE cs.species_id = a.species_id AND c.user_id = $1) AS has_photo
           FROM affected a
       ) p
      WHERE us.user_id = $1 AND us.species_id = p.species_id
        AND (p.has_photo AND us.state IS DISTINCT FROM 'collected'
             OR NOT p.has_photo AND us.state = 'collected')`,
    [userId, captureIds],
  );
}
