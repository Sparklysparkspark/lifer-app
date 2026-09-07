-- Countries where a species' GBIF records almost certainly reflect an escaped/introduced
-- population rather than its real native range — e.g. a popular cage bird native to one
-- country turning up in scattered records continents away. Computed once by the elusiveness
-- crawl (packages/data-pipeline/src/build/compute-elusiveness.ts) using each country's own
-- share of that species' total records plus real geographic distance from the country holding
-- the largest share, not just record-count thresholds. Consumed both by endemic-country
-- labeling (a flagged country no longer counts toward "how many countries is this species
-- really in") and by compute-provinces-bulk.ts's is_vagrant computation for that country's
-- own regions.
CREATE TABLE species_nonnative_countries (
  species_id   uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  country_iso3 text NOT NULL,
  PRIMARY KEY (species_id, country_iso3)
);
