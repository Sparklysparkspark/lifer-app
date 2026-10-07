-- True when iNaturalist has a photo for this species that Lifer may not redistribute (its license
-- isn't publishable, licensePolicy.ts), so packs, the photo store and the catalog seed ship the
-- species without one. Set by the pipeline (photoLicensePolicy.ts, publishable-only enrichment)
-- and shipped in the catalog seed. Installs fetch that photo from iNaturalist for personal
-- viewing in the background (apps/api/src/species/withheldPhotos.ts).
ALTER TABLE species ADD COLUMN photo_withheld boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN species.photo_withheld IS
  'iNaturalist has a photo for this species that Lifer may not redistribute; installs fetch it for personal viewing.';

-- The background fetch looks only at these, a few thousand rows out of the whole catalog.
CREATE INDEX idx_species_photo_withheld_missing ON species (id) WHERE photo_withheld AND reference_photo IS NULL;
