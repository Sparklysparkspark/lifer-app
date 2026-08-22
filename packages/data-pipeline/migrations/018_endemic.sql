-- Flags species that are only ever found (real GBIF presence, same MIN_RECORDS bar a region
-- checklist uses) in exactly one of the 258 countries crawled by
-- compute-elusiveness.ts. Stored as a plain ISO3 code rather than a regions.id foreign key —
-- every country is already seeded as a region at build time (see build-regions.ts), so the
-- API can resolve name/id by joining on regions.external_codes at read time; storing the
-- code directly avoids a migration-order dependency on regions existing first.
ALTER TABLE species_traits ADD COLUMN endemic_country_iso3 text NULL;
