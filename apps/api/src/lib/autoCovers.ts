// Covers Lifer picked itself (a species' featured photo, an album's cover) that show a RAW's
// embedded preview move to the user's edit once one exists. A cover the user chose never moves.
// Trips and an album with no stored cover pick theirs live, with AUTO_COVER_ORDER.
import type { PoolClient } from "pg";
import { pool } from "@lifer/core/db.js";
import { BEST_PHOTO_ORDER, rawPreviewOf } from "./bestPhotoOrder.js";

type Queryable = Pick<PoolClient, "query">;

export interface MovedCover {
  userId: string;
  speciesId: string;
  oldCaptureId: string;
  newCaptureId: string;
}

/** Moves automatic RAW-preview covers onto the best edited photo: highest rated, then the first
 *  imported. `userId` null runs for everyone; `speciesIds` limits the species (albums always run,
 *  as they are few). Returns the species that moved, to frame and re-tag after commit. */
export async function preferEditedCovers(
  userId: string | null,
  speciesIds: string[] | null = null,
  db: Queryable = pool,
): Promise<MovedCover[]> {
  // Only photos of the species itself: an edit where it's a secondary tag never replaces one of it.
  const species = await db.query<MovedCover>(
    `WITH moved AS (
       SELECT us.user_id, us.species_id, cp.capture_id AS old_capture_id, pick.id AS new_capture_id, pick.photo_id
       FROM user_species us
       JOIN photos cp ON cp.id = us.cover_photo_id
       JOIN captures_all cc ON cc.id = cp.capture_id
       CROSS JOIN LATERAL (
         SELECT c.id, c.current_photo_id AS photo_id FROM captures c JOIN photos p ON p.id = c.current_photo_id
         WHERE c.user_id = us.user_id AND c.species_id = us.species_id AND p.kind = 'image'
           AND NOT ${rawPreviewOf("c")}
         ORDER BY c.quality_rating DESC NULLS LAST, c.created_at, c.id
         LIMIT 1
       ) pick
       WHERE ($1::uuid IS NULL OR us.user_id = $1) AND ($2::uuid[] IS NULL OR us.species_id = ANY($2::uuid[]))
         AND us.cover_photo_id IS DISTINCT FROM us.cover_chosen_photo_id
         AND ${rawPreviewOf("cc")}
     )
     UPDATE user_species us SET cover_photo_id = m.photo_id, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
     FROM moved m WHERE us.user_id = m.user_id AND us.species_id = m.species_id
     RETURNING us.user_id AS "userId", us.species_id AS "speciesId",
               m.old_capture_id AS "oldCaptureId", m.new_capture_id AS "newCaptureId"`,
    [userId, speciesIds],
  );
  // A cover the user framed counts as chosen too.
  await db.query(
    `WITH moved AS (
       SELECT a.id, pick.photo_id
       FROM albums a
       JOIN photos cp ON cp.id = a.cover_photo_id
       JOIN captures_all cc ON cc.id = cp.capture_id
       CROSS JOIN LATERAL (
         SELECT c.current_photo_id AS photo_id
         FROM album_captures ac JOIN captures c ON c.id = ac.capture_id JOIN photos p ON p.id = c.current_photo_id
         WHERE ac.album_id = a.id AND p.kind = 'image' AND NOT ${rawPreviewOf("c")}
         ORDER BY ${BEST_PHOTO_ORDER}
         LIMIT 1
       ) pick
       WHERE ($1::uuid IS NULL OR a.user_id = $1) AND a.rules IS NULL
         AND a.cover_photo_id = a.cover_auto_photo_id AND a.cover_crop_x IS NULL
         AND ${rawPreviewOf("cc")}
     )
     UPDATE albums a SET cover_photo_id = m.photo_id, cover_auto_photo_id = m.photo_id
     FROM moved m WHERE a.id = m.id`,
    [userId],
  );
  return species.rows;
}
