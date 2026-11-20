// Frames an album's cover and quad tiles on the animal when the user hasn't cropped them, as the
// Collection's species cards are. Kept in memory by photo id: there's no per-photo crop column,
// and the inference worker remembers each photo's result, so detecting again after a restart is cheap.
// Like ensureDefaultCardCropLater, detection runs in the background: a first load shows the plain crop.
import { readFile } from "node:fs/promises";
import type { QuadSlot } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { detectDefaultCardCrop, type CardCrop } from "../species/detectAndCrop.js";

// shortcut: grows with every photo ever used as a cover (a few per album), bound it if that gets large.
const found = new Map<string, CardCrop | null>();
const detecting = new Set<string>();

type Crop = { cropX: number | null; cropY: number | null; cropSize: number | null };

/** The user's crop when set, else the photo's detected default (once known), else none. */
function withDefault<T extends Crop>(photoId: string | null, crop: T, missing: string[]): T {
  if (!photoId || crop.cropX != null) return crop;
  const detected = found.get(photoId);
  if (detected === undefined) missing.push(photoId);
  return detected ? { ...crop, cropX: detected.x, cropY: detected.y, cropSize: detected.size } : crop;
}

/** Fills the cover's and tiles' unset crops with detected defaults, starting detection for unknown photos. */
export function applyDefaultCoverCrops<
  T extends {
    coverPhotoId: string | null;
    coverCropX: number | null;
    coverCropY: number | null;
    coverCropSize: number | null;
    quadSlots: Array<QuadSlot | null>;
  },
>(album: T): T {
  const missing: string[] = [];
  const cover = withDefault(
    album.coverPhotoId,
    { cropX: album.coverCropX, cropY: album.coverCropY, cropSize: album.coverCropSize },
    missing,
  );
  const quadSlots = album.quadSlots.map((slot) => (slot ? withDefault(slot.photoId, slot, missing) : slot));
  if (missing.length) void detectLater(missing);
  return { ...album, coverCropX: cover.cropX, coverCropY: cover.cropY, coverCropSize: cover.cropSize, quadSlots };
}

/** The detected crops already known for these photos, starting detection for the rest. */
export function knownDefaultCrops(photoIds: string[]): Map<string, CardCrop> {
  const known = new Map<string, CardCrop>();
  const missing: string[] = [];
  for (const id of photoIds) {
    const detected = found.get(id);
    if (detected === undefined) missing.push(id);
    else if (detected) known.set(id, detected);
  }
  if (missing.length) void detectLater(missing);
  return known;
}

/** Detects default crops for these photos one at a time. Best-effort: a failure records no crop. */
export async function detectLater(photoIds: string[]): Promise<void> {
  const todo = [...new Set(photoIds)].filter((id) => !found.has(id) && !detecting.has(id));
  if (!todo.length) return;
  for (const id of todo) detecting.add(id);
  try {
    const res = await pool.query<{ id: string; display_path: string | null }>(
      `SELECT id, display_path FROM photos WHERE id = ANY($1::uuid[])`,
      [todo],
    );
    const paths = new Map(res.rows.map((r) => [r.id, r.display_path]));
    for (const id of todo) {
      const displayPath = paths.get(id);
      let crop: CardCrop | null = null;
      try {
        if (displayPath) crop = await detectDefaultCardCrop(await readFile(displayPath), { priority: "background" });
      } catch {
        // Unreadable file: no default, as with the species cards.
      }
      found.set(id, crop);
    }
  } catch {
    // The lookup failed: leave these unknown so a later load retries.
  } finally {
    for (const id of todo) detecting.delete(id);
  }
}
