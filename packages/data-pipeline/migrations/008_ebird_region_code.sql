-- For the eBird Illustrated Checklist deep link (Phase 3, spec §9) only — a different code
-- space than external_codes, which holds the GADM code used for GBIF occurrence queries
-- (migration 001/build-region-species.ts). Don't conflate the two.
ALTER TABLE regions ADD COLUMN ebird_region_code text NULL;

UPDATE regions SET ebird_region_code = 'CA-BC' WHERE name = 'British Columbia';
