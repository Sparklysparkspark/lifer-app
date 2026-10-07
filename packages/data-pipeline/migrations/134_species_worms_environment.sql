-- The habitats WoRMS (World Register of Marine Species) records for a species: marine, brackish,
-- freshwater, terrestrial. compute-sea-zones-offline.ts leaves freshwater-only species off sea
-- zone checklists with them, and lets a marine species seen only a few times in a zone stay when
-- it's established in a neighbouring zone. Filled by fetch-worms-environment.ts; NULL means not
-- looked up, and worms_checked_at with every flag NULL means WoRMS doesn't know the name.
ALTER TABLE species_traits
  ADD COLUMN worms_aphia_id integer,
  ADD COLUMN worms_is_marine boolean,
  ADD COLUMN worms_is_brackish boolean,
  ADD COLUMN worms_is_freshwater boolean,
  ADD COLUMN worms_is_terrestrial boolean,
  ADD COLUMN worms_checked_at timestamptz;
