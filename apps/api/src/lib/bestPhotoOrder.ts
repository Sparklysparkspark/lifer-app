import { filesCaptureOf } from "./versionFiles.js";

// Best available photo quality signal: the user's rating, then the newest.
// shortcut: no stored sharpness or subject scores yet, upgrade when the analysis job saves them.
export const BEST_PHOTO_ORDER = `c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST, c.id`;

/** SQL: capture `c` shows a RAW's embedded preview, as every file behind its photo is a RAW. An
 *  edit or a JPEG is what the photographer meant people to see. */
export const rawPreviewOf = (c: string) =>
  `COALESCE((SELECT bool_and(rp.kind = 'raw') FROM originals rp WHERE rp.capture_id = ${filesCaptureOf(c)}), false)`;

/** A cover Lifer picks itself: an edit or JPEG before a RAW's preview, then the best photo. */
export const AUTO_COVER_ORDER = `${rawPreviewOf("c")}, ${BEST_PHOTO_ORDER}`;
