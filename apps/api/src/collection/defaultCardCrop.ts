// Frames a species card on the animal when Lifer picks the cover photo itself.
// Only fills an empty crop, and only if the cover is unchanged once detection finishes.
// Best-effort: no subject or any error leaves the crop empty.
import { readFile } from "node:fs/promises";
import { pool } from "../db.js";
import { detectDefaultCardCrop } from "../species/detectAndCrop.js";

export async function ensureDefaultCardCrop(userId: string, speciesId: string): Promise<void> {
  try {
    const res = await pool.query<{ cover_photo_id: string; display_path: string | null }>(
      `SELECT us.cover_photo_id, p.display_path
       FROM user_species us JOIN photos p ON p.id = us.cover_photo_id
       WHERE us.user_id = $1 AND us.species_id = $2 AND us.card_crop_x IS NULL`,
      [userId, speciesId],
    );
    const row = res.rows[0];
    if (!row?.display_path) return;
    const crop = await detectDefaultCardCrop(await readFile(row.display_path));
    if (!crop) return;
    await pool.query(
      `UPDATE user_species SET card_crop_x = $1, card_crop_y = $2, card_crop_size = $3
       WHERE user_id = $4 AND species_id = $5 AND cover_photo_id = $6 AND card_crop_x IS NULL`,
      [crop.x, crop.y, crop.size, userId, speciesId, row.cover_photo_id],
    );
  } catch {
    // Best-effort, see the top comment.
  }
}

/** Fire-and-forget form for request handlers: never delays or fails the response. */
export function ensureDefaultCardCropLater(userId: string, speciesId: string): void {
  void ensureDefaultCardCrop(userId, speciesId);
}
