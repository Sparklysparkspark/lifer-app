// Finds the animal in a photo, for the species card's default framing and the import screen's
// "doesn't look like wildlife" check. Detection runs in the inference worker, which remembers
// each photo's result by content hash so one pass serves every use.
import { pool } from "@lifer/core/db.js";
import {
  analyzeImage,
  contentHash,
  type CardCrop,
  type ImageSource,
  type Priority,
  type SubjectPresence,
} from "@lifer/core/species/inference.js";

export type { CardCrop, SubjectPresence };

/** A default square card crop (percentages of the photo's width) centered on the subject. Null on
 * no detection or any failure; callers then leave the crop unset. */
export async function detectDefaultCardCrop(
  buffer: Buffer,
  opts: { priority?: Priority } = {},
): Promise<CardCrop | null> {
  try {
    const result = await analyzeImage(buffer, {
      targets: [],
      cardCrop: true,
      key: contentHash(buffer),
      priority: opts.priority ?? "commit",
    });
    return result.cardCrop;
  } catch {
    return null;
  }
}

/** Person and animal scores from the whole-frame pass. The detector knows only ten animal kinds,
 * so the useful signal is a confident person with no animal. Throws when detection can't run. */
export async function detectSubjectPresence(buffer: Buffer): Promise<SubjectPresence> {
  const result = await analyzeImage(buffer, {
    targets: [],
    presence: true,
    key: contentHash(buffer),
    priority: "interactive",
  });
  if (!result.presence) throw new Error("Couldn't run the animal detector on this photo");
  return result.presence;
}

/** Saves how many animals the detector found, for Gallery search by number of animals. */
export async function storeSubjectCount(captureId: string, presence: SubjectPresence | null): Promise<void> {
  if (!presence) return;
  await pool.query(`UPDATE captures_all SET subject_count = $1 WHERE id = $2`, [presence.count, captureId]);
}

/** Counts the animals in a capture's photo and saves it. Throws when detection can't run. */
export async function countCaptureSubjects(captureId: string, image: ImageSource, priority: Priority): Promise<void> {
  const result = await analyzeImage(image, { targets: [], presence: true, priority });
  if (!result.presence) throw new Error("Couldn't run the animal detector on this photo");
  await storeSubjectCount(captureId, result.presence);
}
