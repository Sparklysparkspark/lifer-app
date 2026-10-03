// A species card's crop is a square stored as percentages of the photo's width (migration 006).
// The smallest one allowed, drawn in the crop editor or picked around the detected animal:
// any tighter and a card shows too few pixels to tell what the animal is.
export const MIN_CARD_CROP_PERCENT = 8;
