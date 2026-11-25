import type { PoolClient } from "pg";
import { rawPreviewOf } from "./bestPhotoOrder.js";

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

// A recording of a species means it was heard: it counts as seen, never collected, and never
// downgrades a species the user already photographed.
export async function markHeard(db: Queryable, userId: string, speciesId: string): Promise<void> {
  await db.query(
    `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')
     ON CONFLICT (user_id, species_id) DO UPDATE SET state = COALESCE(user_species.state, 'seen')`,
    [userId, speciesId],
  );
}

// A species' fallback cover: its best remaining photo, an edit before a RAW's preview, then
// highest rated then newest (the same pick as replaceUnshowableCover in photos/routes.ts). Photos
// where it's only a secondary tag come last. Reads the `captures` view, so trashed captures never qualify.
const BEST_REMAINING_PHOTO_SQL = `(
  SELECT b.photo_id FROM (
    SELECT c.current_photo_id AS photo_id, 0 AS secondary, ${rawPreviewOf("c")} AS raw_preview,
           c.quality_rating, c.taken_at, c.id
    FROM captures c
    WHERE c.user_id = us.user_id AND c.species_id = us.species_id AND c.current_photo_id IS NOT NULL
    UNION ALL
    SELECT c.current_photo_id, 1, ${rawPreviewOf("c")}, c.quality_rating, c.taken_at, c.id
    FROM capture_species cs JOIN captures c ON c.id = cs.capture_id
    WHERE cs.species_id = us.species_id AND c.user_id = us.user_id AND c.current_photo_id IS NOT NULL
  ) b
  ORDER BY b.secondary, b.raw_preview, b.quality_rating DESC NULLS LAST, b.taken_at DESC NULLS LAST, b.id
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

/** Keeps the life-list state in step with the media you can see, for the species of `captureIds`:
 *  a photo or video makes it collected, else a recording makes it heard (seen), else it falls back
 *  to nothing. A seen state is only cleared when a trashed recording was what made it seen, so a
 *  species marked seen by hand keeps it. Reads the `captures` view, which hides trashed captures;
 *  a photo where the species is a secondary tag counts too. Run after trashing or restoring. */
export async function syncCollectedState(db: Queryable, userId: string, captureIds: string[]): Promise<void> {
  if (captureIds.length === 0) return;
  await db.query(
    `WITH affected AS (
       SELECT species_id FROM captures_all WHERE id = ANY($2::uuid[])
       UNION SELECT species_id FROM capture_species WHERE capture_id = ANY($2::uuid[])
     ),
     visible AS (
       SELECT c.species_id, p.kind FROM captures c JOIN photos p ON p.id = c.current_photo_id WHERE c.user_id = $1
       UNION ALL
       SELECT cs.species_id, p.kind FROM capture_species cs JOIN captures c ON c.id = cs.capture_id
         JOIN photos p ON p.id = c.current_photo_id WHERE c.user_id = $1
     ),
     wanted AS (
       SELECT a.species_id,
              EXISTS (SELECT 1 FROM visible v WHERE v.species_id = a.species_id AND v.kind <> 'audio') AS has_photo,
              EXISTS (SELECT 1 FROM visible v WHERE v.species_id = a.species_id AND v.kind = 'audio') AS has_audio,
              EXISTS (SELECT 1 FROM captures_all t JOIN photos tp ON tp.id = t.current_photo_id
                       WHERE t.id = ANY($2::uuid[]) AND t.species_id = a.species_id AND tp.kind = 'audio') AS touched_audio
         FROM affected a
     ),
     next AS (
       SELECT us.species_id,
              CASE WHEN w.has_photo THEN 'collected'
                   WHEN w.has_audio THEN 'seen'
                   WHEN us.state = 'collected' OR (us.state = 'seen' AND w.touched_audio) THEN NULL
                   ELSE us.state END AS state
         FROM user_species us JOIN wanted w ON w.species_id = us.species_id
        WHERE us.user_id = $1
     )
     UPDATE user_species us SET state = n.state
       FROM next n
      WHERE us.user_id = $1 AND us.species_id = n.species_id AND us.state IS DISTINCT FROM n.state`,
    [userId, captureIds],
  );
}
