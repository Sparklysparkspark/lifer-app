-- Where each synonym link came from, so the ones made automatically by
-- scripts/reconcile-species-names.ts can be audited and rebuilt without touching the rest:
--   'col'    Catalogue of Life (the taxonomy GBIF downloads now use): an old name's accepted name
--   'inat'   iNaturalist: its current name, or a species split out of the catalog's one
--   'ebird'  eBird/Clements taxonomy
--   NULL     made before this column existed (build-species-name-index.ts), or by hand
ALTER TABLE species_synonyms ADD COLUMN source TEXT;
