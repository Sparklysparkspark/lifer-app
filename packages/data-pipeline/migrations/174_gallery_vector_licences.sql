-- Each gallery vector carries its photo's licence, photographer and source page, so the openly
-- licensed subset can be told apart and credited. Existing rows take the licence and credit of
-- the photo they were computed from.
ALTER TABLE species_reference_gallery_embeddings
  ADD COLUMN license text,
  ADD COLUMN photographer text,
  ADD COLUMN source_url text;

UPDATE species_reference_gallery_embeddings ge
   SET license = p.license, photographer = p.credit
  FROM species_reference_photos p
 WHERE p.id = ge.reference_photo_id;
