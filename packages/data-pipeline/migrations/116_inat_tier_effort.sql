-- Research-grade iNaturalist observations per region and species group: photographs, confirmed
-- by the community. Rarity tiers are rated on a species' share of its group's photos in a place
-- (region_species.inat_rg_count over this), since that measures how hard a photo is to get more
-- directly than GBIF record counts, which are dominated by checklists and fisheries surveys.
ALTER TABLE region_group_effort ADD COLUMN inat_rg_records bigint;
