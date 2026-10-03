-- Species card crops tighter than MIN_CARD_CROP_PERCENT (packages/shared/src/cardCrop.ts, 8% of the
-- photo's width): automatic crops around a small or distant animal had no floor, so a card could
-- show too few pixels to tell what it was. Each is widened to the minimum around the same centre,
-- kept inside the photo (its height as a share of its width, when the photo's size is known).
UPDATE user_species us
SET card_crop_size = 8,
    card_crop_x = LEAST(GREATEST(us.card_crop_x + us.card_crop_size / 2 - 4, 0), 92),
    card_crop_y = LEAST(
      GREATEST(us.card_crop_y + us.card_crop_size / 2 - 4, 0),
      GREATEST(COALESCE((SELECT p.height::numeric * 100 / NULLIF(p.width, 0) FROM photos p WHERE p.id = us.cover_photo_id), 100) - 8, 0)
    )
WHERE us.card_crop_size < 8;
