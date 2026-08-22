-- Reference photos (previously just hotlinked external URLs) get a local cached copy so
-- pages load faster and don't depend on iNaturalist/Wikimedia Commons being up, and so an
-- offline region-download feature has something real to bundle. The external URL/credit/
-- license columns (migration 001/003) are kept as-is — still the attribution source of
-- truth, and the fallback if a local file ever goes missing.
ALTER TABLE species ADD COLUMN reference_display_path text NULL;
ALTER TABLE species ADD COLUMN reference_thumb_path text NULL;
ALTER TABLE species_reference_photos ADD COLUMN display_path text NULL;
ALTER TABLE species_reference_photos ADD COLUMN thumb_path text NULL;
