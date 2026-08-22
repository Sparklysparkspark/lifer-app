-- Lets the card-grid thumbnail be framed differently from the full featured/hero photo on
-- the species detail page. Stored as a crop *center point* (percentages, CSS object-position
-- semantics) rather than a full crop rectangle — simpler to store and to build a UI for, and
-- combined with object-fit:cover on the card <img> it's enough to recenter on the bird without
-- needing zoom/resize controls in the first pass.

ALTER TABLE user_species
  ADD COLUMN card_crop_x numeric NOT NULL DEFAULT 50 CHECK (card_crop_x BETWEEN 0 AND 100),
  ADD COLUMN card_crop_y numeric NOT NULL DEFAULT 50 CHECK (card_crop_y BETWEEN 0 AND 100);
