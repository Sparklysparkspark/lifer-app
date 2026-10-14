-- People aren't something to log, so they're on no checklist (core/species/neverListed.ts). Packs
-- and the catalog seed leave them out from now on, and installing an older pack skips them; this
-- clears the rows earlier packs and seeds added. Catalog rows only: a person a user added to a
-- checklist themselves stays.
DELETE FROM region_species_hotspots WHERE species_id IN (SELECT id FROM species WHERE scientific_name = 'Homo sapiens');
DELETE FROM region_species WHERE species_id IN (SELECT id FROM species WHERE scientific_name = 'Homo sapiens');
DELETE FROM sea_zone_species WHERE species_id IN (SELECT id FROM species WHERE scientific_name = 'Homo sapiens');
