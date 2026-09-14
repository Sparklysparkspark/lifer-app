-- iNaturalist's own place identifier (their /v1/places system, distinct from ebird_region_code
-- and external_codes) — resolved lazily and cached here the first time a region's checklist is
-- computed against iNaturalist Research Grade data (see compute-provinces-bulk.ts's
-- resolveInatPlaceId), rather than backfilled up front for every region at once.
ALTER TABLE regions ADD COLUMN IF NOT EXISTS inat_place_id integer NULL;
