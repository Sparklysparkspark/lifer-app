-- Inputs for absolute, explainable rarity tiers (compute-local-tiers.ts, compute-global-tiers.ts),
-- the record of taxa a region has that the catalog lacks, per-user tier overrides, and the
-- refresh pipeline's run log. Tiers used to be percentile ranks against the other species on the
-- same list; they are now fixed thresholds on how often a species is actually recorded relative
-- to how much observing happens there, plus absolute traits, and each tier carries its reasons.

-- Per checklist row: the evidence the tier is computed from.
ALTER TABLE region_species
  ADD COLUMN live_recent_records integer,      -- HUMAN_OBSERVATION / OBSERVATION / MACHINE_OBSERVATION, last 15 years
  ADD COLUMN recent_distinct_years smallint,   -- distinct years among those records
  ADD COLUMN evidence_source text,             -- 'gbif', 'inat', 'ebird' or a '+'-joined mix
  ADD COLUMN inat_rg_count integer,            -- iNaturalist research-grade observations in this place
  ADD COLUMN tier_reason text,                 -- why local_tier is what it is, or why it's NULL ('thin_data', 'domestic', ...)
  ADD COLUMN tier_explain jsonb;               -- rate, group, effort, base tier and every step that moved it

ALTER TABLE species_rarity
  ADD COLUMN tier_reason text,
  ADD COLUMN tier_explain jsonb;

ALTER TABLE sea_zone_species
  ADD COLUMN local_tier text CHECK (local_tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  ADD COLUMN live_recent_records integer,
  ADD COLUMN tier_reason text,
  ADD COLUMN tier_explain jsonb;

-- Observer effort per region and species group: all recent live records of that group there,
-- whatever the species. The denominator that stops a heavily watched province from making every
-- species in it look easy. Computed from the GBIF country downloads, independent of the catalog.
CREATE TABLE region_group_effort (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_group text NOT NULL,
  live_recent_records bigint NOT NULL,
  all_records bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, species_group)
);

-- Taxa a region's sources report that match no catalog species. These used to be dropped
-- without a trace, which is how whole species (splits the catalog never got) went missing from
-- every checklist. The catalog stage adds them and sets resolved_species_id.
CREATE TABLE region_unmatched_taxa (
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('inat', 'gbif', 'ebird')),
  external_id text NOT NULL,                   -- iNaturalist taxon id, GBIF name, or eBird code
  name text NOT NULL,
  record_count integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_species_id uuid REFERENCES species(id) ON DELETE SET NULL,
  PRIMARY KEY (region_id, source, external_id)
);
CREATE INDEX region_unmatched_taxa_unresolved_idx ON region_unmatched_taxa (source, external_id) WHERE resolved_species_id IS NULL;

-- A user's own tier for a species, in one region or everywhere (region_id NULL). Wins over the
-- computed tier on that install only.
CREATE TABLE user_tier_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id uuid REFERENCES regions(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_tier_overrides_key ON user_tier_overrides
  (user_id, COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid), species_id);

-- The refresh pipeline's log (packages/data-pipeline/src/scripts/refresh.ts): one row per stage
-- and item, so a run can resume and later runs know what is already done.
CREATE TABLE pipeline_runs (
  run_id uuid NOT NULL,
  stage text NOT NULL,
  item text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  notes jsonb,
  PRIMARY KEY (run_id, stage, item)
);
CREATE INDEX pipeline_runs_stage_item_idx ON pipeline_runs (stage, item, finished_at DESC);
