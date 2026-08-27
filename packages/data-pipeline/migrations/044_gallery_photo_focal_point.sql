-- Same focal-point model as species.reference_focal_x/y (migration 043), for the SECONDARY
-- gallery photos (species_reference_photos — the extra photos arrowed through in the hero
-- viewer) instead of just each species' primary reference photo. See that migration's own
-- comment for why this is a focal point rather than a crop rect.
ALTER TABLE species_reference_photos
  ADD COLUMN focal_x numeric NULL CHECK (focal_x BETWEEN 0 AND 100),
  ADD COLUMN focal_y numeric NULL CHECK (focal_y BETWEEN 0 AND 100);
