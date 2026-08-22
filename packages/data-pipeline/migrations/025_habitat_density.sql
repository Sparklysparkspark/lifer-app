-- Pileated Woodpecker is a textbook case the composite score was missing: a real, sizeable
-- population, but spread through dense forest and genuinely hard to actually see, which the
-- previous signals alone read as "common." AVONET already publishes a per-species Habitat
-- (Forest/Woodland/Grassland/etc.) and Habitat.Density (1=dense/closed canopy, 3=open)
-- rating in its source workbook, never extracted until now. Habitat.Density is the real,
-- verifiable signal for "detectability due to habitat cover" — distinct from raw record
-- volume, which conflates observer frequency with detectability.
ALTER TABLE species_traits ADD COLUMN primary_habitat text NULL;
ALTER TABLE species_traits ADD COLUMN habitat_density smallint NULL;
