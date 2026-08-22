-- Replaces the click-to-center-point crop (migration 005) with a real move+resize square
-- crop. All three values are fractions (0-100) of the photo's own WIDTH — including the Y
-- offset, deliberately, not a separate height-relative unit. Because the crop box is square
-- in the image's own pixel space, using one consistent denominator (width) for x, y, and size
-- means the card thumbnail can be rendered with pure CSS percentages (position:absolute,
-- width%, left%, top%) without the frontend ever needing to know the image's natural pixel
-- dimensions — the math is scale-invariant.
--
-- Nullable (no default): null means "no custom crop yet, just object-fit:cover centered",
-- which is a fine default and avoids picking an arbitrary literal that might not even fit
-- inside a non-square photo.

ALTER TABLE user_species DROP COLUMN card_crop_x;
ALTER TABLE user_species DROP COLUMN card_crop_y;

ALTER TABLE user_species
  ADD COLUMN card_crop_x numeric NULL CHECK (card_crop_x BETWEEN 0 AND 100),
  ADD COLUMN card_crop_y numeric NULL CHECK (card_crop_y BETWEEN 0 AND 100),
  ADD COLUMN card_crop_size numeric NULL CHECK (card_crop_size > 0 AND card_crop_size <= 100);
