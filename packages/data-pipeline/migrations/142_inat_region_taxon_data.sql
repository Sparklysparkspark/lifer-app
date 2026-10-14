-- Weekly observation counts for species added by hand (Other Taxa), which no catalog pack covers,
-- from iNaturalist (api/species/inatDistribution.ts). Fetched when the species is added to a
-- region, for that country and its provinces or states, one row per region, so they're there
-- offline. 52 values like region_species.weekly_frequency; null when iNaturalist has no records.
-- Public data about the species, so not per user, like region_species.
CREATE TABLE IF NOT EXISTS inat_region_taxon_data (
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  weekly_frequency integer[],
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (species_id, region_id)
);
