// Best available photo quality signal: the user's rating, then the newest.
// shortcut: no stored sharpness or subject scores yet, upgrade when the analysis job saves them.
export const BEST_PHOTO_ORDER = `c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST, c.id`;
