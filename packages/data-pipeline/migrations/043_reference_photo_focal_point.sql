-- A focal point (x, y as fractions 0-100 of the full photo's own width/height), not a square
-- crop rect like user_species.card_crop_* (migration 006) — a reference photo shows up in
-- more than one differently-shaped box across the app (square card thumbnail, 16:9 detail-
-- page hero), and a plain CSS object-position percentage works correctly against ANY box
-- shape from one stored value, where a crop rect would need one per shape. Applied at render
-- time only (object-position), same non-destructive principle as card_crop_*: the full
-- reference photo on disk is never touched, so this can be freely changed (or reset) without
-- ever needing to re-fetch anything.
-- Nullable, no default: null means "no custom focal point set, just centered" (50%/50%),
-- same convention as card_crop_x/y being null.
ALTER TABLE species
  ADD COLUMN reference_focal_x numeric NULL CHECK (reference_focal_x BETWEEN 0 AND 100),
  ADD COLUMN reference_focal_y numeric NULL CHECK (reference_focal_y BETWEEN 0 AND 100);
