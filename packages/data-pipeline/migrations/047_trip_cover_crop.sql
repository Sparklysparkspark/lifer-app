-- Parity with user_species.card_crop_x/y/size (migration 006) — a trip's manually-picked
-- cover photo gets the same drag-to-crop control as a species' own cover photo
-- (CardCropEditor.tsx, generalized to take a save callback instead of being species-specific).
ALTER TABLE trips
  ADD COLUMN cover_crop_x numeric NULL CHECK (cover_crop_x BETWEEN 0 AND 100),
  ADD COLUMN cover_crop_y numeric NULL CHECK (cover_crop_y BETWEEN 0 AND 100),
  ADD COLUMN cover_crop_size numeric NULL CHECK (cover_crop_size > 0 AND cover_crop_size <= 100);
