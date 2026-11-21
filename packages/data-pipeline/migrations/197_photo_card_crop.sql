-- A species card crop per photo, so a trip or album card showing a photo other than the species'
-- featured one keeps its own framing. Same units as user_species.card_crop_* (migration 006).
-- The featured photo's crop lives on user_species only; these hold every other photo's.
ALTER TABLE photos
  ADD COLUMN card_crop_x numeric NULL CHECK (card_crop_x BETWEEN 0 AND 100),
  ADD COLUMN card_crop_y numeric NULL CHECK (card_crop_y BETWEEN 0 AND 100),
  ADD COLUMN card_crop_size numeric NULL CHECK (card_crop_size > 0 AND card_crop_size <= 100);

-- A photo that becomes featured with no crop brings its own, whichever code path repoints it.
CREATE FUNCTION user_species_carry_photo_crop() RETURNS trigger AS $$
BEGIN
  IF NEW.cover_photo_id IS NOT NULL AND NEW.card_crop_x IS NULL
     AND (TG_OP = 'INSERT' OR NEW.cover_photo_id IS DISTINCT FROM OLD.cover_photo_id) THEN
    SELECT p.card_crop_x, p.card_crop_y, p.card_crop_size
      INTO NEW.card_crop_x, NEW.card_crop_y, NEW.card_crop_size
      FROM photos p WHERE p.id = NEW.cover_photo_id AND p.card_crop_x IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_species_carry_photo_crop BEFORE INSERT OR UPDATE OF cover_photo_id ON user_species
  FOR EACH ROW EXECUTE FUNCTION user_species_carry_photo_crop();
