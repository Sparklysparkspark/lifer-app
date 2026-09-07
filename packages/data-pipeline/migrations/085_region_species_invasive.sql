-- A species can be firmly established in a region (not vagrant) while still being non-native
-- and ecologically harmful there — Wild Boar in Alberta is the confirmed live case: a real,
-- government-tracked, self-sustaining feral population from escaped livestock, not a vagrant
-- or a stray, but not a natural part of the region's fauna either. is_vagrant alone can't
-- express this (it would either wrongly mark the species vagrant, hiding a real findable
-- population, or wrongly imply it's a natural resident). This is a separate, orthogonal fact —
-- always set alongside is_vagrant = false, never inferred automatically (no record-count
-- pattern distinguishes "invasive but real" from "native but real"), only ever set via
-- region_species_manual_overrides after an authoritative external source confirms it.
ALTER TABLE region_species ADD COLUMN is_invasive boolean NOT NULL DEFAULT false;
ALTER TABLE region_species_manual_overrides ADD COLUMN is_invasive boolean;
