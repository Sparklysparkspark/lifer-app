-- Compute-provinces-bulk.ts's per-species checklist logic only ever has GBIF record-count
-- patterns to go on — real range (does this species actually live here) is a question that
-- record-count patterns alone can't always answer, especially for a hard-to-detect species
-- with a small, historically-lumpy record total (Mountain Beaver in British Columbia: 11
-- distinct years across 124 years of real records, but one 1901 museum collecting trip alone
-- accounts for over half the total, failing the pattern check outright). This table holds a
-- verified answer from an authoritative outside source (a government species-at-risk report,
-- a recognized range map) for a specific (region, species) pair, checked at write time and
-- taking precedence over whatever the record-pattern check alone would have concluded — see
-- its own comment in compute-provinces-bulk.ts for how it gets consulted.
CREATE TABLE region_species_manual_overrides (
  region_id UUID NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_id UUID NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  is_vagrant BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, species_id)
);
