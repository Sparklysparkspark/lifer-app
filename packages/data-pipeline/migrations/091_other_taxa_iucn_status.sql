-- Other Taxa species (migration 089) never get a rarity tier computed — no dataset to rank
-- them against. IUCN conservation status (pulled from iNaturalist's own taxon record at add
-- time) fills that same badge slot with something real instead of leaving it empty.
ALTER TABLE species ADD COLUMN IF NOT EXISTS iucn_status text NULL;
