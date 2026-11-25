// Frames a species card on the animal when Lifer picks the cover photo itself.
// Only fills an empty crop, and only if the cover is unchanged once detection finishes.
// Best-effort: no subject or any error leaves the crop empty.
import { readFile } from "node:fs/promises";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { detectDefaultCardCrop } from "../species/detectAndCrop.js";
import { preferEditedCovers, type MovedCover } from "../lib/autoCovers.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";

// The "Lifer:Cover" keyword leaves the old cover's sidecar and lands on the new one's.
async function retagMoved(moved: MovedCover[]): Promise<void> {
  for (const m of moved) {
    await syncCaptureXmpSidecarsLogged(m.userId, m.oldCaptureId);
    await syncCaptureXmpSidecarsLogged(m.userId, m.newCaptureId);
  }
}

/** `known`: a crop already found for one photo, used when that photo is the cover. */
export async function ensureDefaultCardCrop(
  userId: string,
  speciesId: string,
  known?: { photoId: string; crop: NonNullable<Awaited<ReturnType<typeof detectDefaultCardCrop>>> },
): Promise<void> {
  try {
    // Every import frames its species here, so a new edit replaces an automatic RAW cover first.
    await retagMoved(await preferEditedCovers(userId, [speciesId]));
    const res = await pool.query<{ cover_photo_id: string; display_path: string | null }>(
      `SELECT us.cover_photo_id, p.display_path
       FROM user_species us JOIN photos p ON p.id = us.cover_photo_id
       WHERE us.user_id = $1 AND us.species_id = $2 AND us.card_crop_x IS NULL`,
      [userId, speciesId],
    );
    const row = res.rows[0];
    if (!row?.display_path) return;
    const crop =
      known?.photoId === row.cover_photo_id
        ? known.crop
        : await detectDefaultCardCrop(await readFile(row.display_path));
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

const pendingRuns = new Map<string, NodeJS.Timeout>();

/** After version changes (or at startup, with null for everyone): moves automatic RAW covers onto
 *  edits, then frames the species that moved. Calls within a moment share one run. */
export function preferEditedCoversLater(userId: string | null): void {
  const key = userId ?? "*";
  if (pendingRuns.has(key)) return;
  const timer = setTimeout(() => {
    pendingRuns.delete(key);
    preferEditedCovers(userId)
      .then(async (moved) => {
        await retagMoved(moved);
        for (const m of moved) await ensureDefaultCardCrop(m.userId, m.speciesId);
      })
      .catch((err: unknown) => log.warn({ err }, "Couldn't move automatic covers onto edited photos"));
  }, 1000);
  timer.unref();
  pendingRuns.set(key, timer);
}
