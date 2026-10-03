// Finds the animal in a photo, for the species card's default framing and the import screen's
// "doesn't look like wildlife" check. Detection runs in the inference worker, which remembers
// each photo's result by content hash so one pass serves every use.
import { analyzeImage, contentHash, type CardCrop, type Priority, type SubjectPresence } from "./inference.js";

export type { CardCrop, SubjectPresence };

/** A default square card crop (percentages of the photo's width) centered on the subject. Null on
 * no detection or any failure; callers then leave the crop unset. */
export async function detectDefaultCardCrop(buffer: Buffer, opts: { priority?: Priority } = {}): Promise<CardCrop | null> {
  try {
    const result = await analyzeImage(buffer, { targets: [], cardCrop: true, key: contentHash(buffer), priority: opts.priority ?? "commit" });
    return result.cardCrop;
  } catch {
    return null;
  }
}

/** Person and animal scores from the whole-frame pass. The detector knows only ten animal kinds,
 * so the useful signal is a confident person with no animal. Throws when detection can't run. */
export async function detectSubjectPresence(buffer: Buffer): Promise<SubjectPresence> {
  const result = await analyzeImage(buffer, { targets: [], presence: true, key: contentHash(buffer), priority: "interactive" });
  if (!result.presence) throw new Error("Couldn't run the animal detector on this photo");
  return result.presence;
}
