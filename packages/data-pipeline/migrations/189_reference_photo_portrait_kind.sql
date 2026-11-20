-- What each reference photo shows, from its CLIP vector (core/species/referencePortrait.ts):
-- 'portrait' for the animal itself, otherwise egg, nest, tracks, scat, bones, specimen, habitat,
-- map, drawing or text. NULL until scored. The score is how much better the photo matches the
-- portrait prompts than the best other kind. Galleries list non-portraits last, and a species
-- whose main photo isn't a portrait swaps it with its best portrait gallery photo.
ALTER TABLE species_reference_photos
  ADD COLUMN portrait_kind text,
  ADD COLUMN portrait_score real;
ALTER TABLE species
  ADD COLUMN reference_portrait_kind text,
  ADD COLUMN reference_portrait_score real;

-- The scoring job looks only at these.
CREATE INDEX idx_species_reference_photos_unscored ON species_reference_photos (id) WHERE portrait_kind IS NULL;
CREATE INDEX idx_species_main_photo_unscored ON species (id)
  WHERE reference_portrait_kind IS NULL AND reference_photo IS NOT NULL;

-- A new main photo needs scoring again, whichever code path set it. Only the URL counts: paths
-- change when files arrive or move. An update that sets the kind itself (the swap) keeps it.
CREATE FUNCTION reset_reference_portrait_kind() RETURNS trigger AS $$
BEGIN
  IF NEW.reference_photo IS DISTINCT FROM OLD.reference_photo
     AND NEW.reference_portrait_kind IS NOT DISTINCT FROM OLD.reference_portrait_kind
     AND NEW.reference_portrait_score IS NOT DISTINCT FROM OLD.reference_portrait_score THEN
    NEW.reference_portrait_kind := NULL;
    NEW.reference_portrait_score := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER species_reset_reference_portrait_kind
  BEFORE UPDATE OF reference_photo ON species
  FOR EACH ROW EXECUTE FUNCTION reset_reference_portrait_kind();
