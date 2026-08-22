-- Phase 1 subset of lifer-spec.md §6. User/capture/photo tables arrive in Phase 2.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE species (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gbif_key          bigint UNIQUE NOT NULL,
  ebird_code        text NULL,
  inat_taxon_id     int NULL,
  scientific_name   text NOT NULL,
  common_name       text,
  taxon_class       text NOT NULL,
  family            text,
  taxon_order       text,
  sort_order        int,
  reference_photo   text NULL,
  reference_credit  text NULL,
  -- The actual CC license code (e.g. 'cc-by', 'cc-by-nc'). Dev/test runs may allow
  -- non-commercial-licensed photos (see fetch-reference-photos.ts LIFER_ALLOW_NONCOMMERCIAL_PHOTOS) —
  -- storing the real code here, rather than just a boolean, makes it a one-line filter
  -- (`reference_license NOT IN ('cc0','cc-by','cc-by-sa')`) to strip them back out before
  -- any commercial launch, without having to re-derive which photos were affected.
  reference_license text NULL,
  -- One-sentence Wikipedia-sourced ID caption, deliberately short per lifer-spec.md §2's
  -- "not a field guide" non-goal — a quick-glance description, not encyclopedic content.
  description             text NULL,
  description_credit      text NULL,
  description_source_url  text NULL,
  CONSTRAINT reference_photo_requires_credit
    CHECK (reference_photo IS NULL OR (reference_credit IS NOT NULL AND reference_license IS NOT NULL)),
  CONSTRAINT description_requires_credit
    CHECK (description IS NULL OR (description_credit IS NOT NULL AND description_source_url IS NOT NULL))
);

CREATE INDEX idx_species_taxon_class ON species (taxon_class);
CREATE INDEX idx_species_scientific_name ON species (scientific_name);

CREATE TABLE species_traits (
  species_id        uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  mass_g            numeric NULL,
  length_mm         numeric NULL,
  wingspan_mm       numeric NULL,
  hand_wing_index   numeric NULL,
  trophic_niche     text NULL,
  primary_lifestyle text NULL,
  nocturnal         boolean NULL,
  density_per_km2   numeric NULL,
  home_range_km2    numeric NULL,
  depth_min_m       numeric NULL,
  depth_max_m       numeric NULL,
  iucn_status       text NULL,
  range_size_km2    numeric NULL,
  source_attribution text NOT NULL
);

CREATE TABLE species_rarity (
  species_id        uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  range_score       numeric NOT NULL,
  abundance_score   numeric NOT NULL,
  elusiveness_score numeric NULL,
  composite         numeric NOT NULL,
  tier              text NOT NULL CHECK (tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE regions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  parent_id         uuid NULL REFERENCES regions(id) ON DELETE SET NULL,
  gbif_area_wkt     text NULL, -- confirmed dead/unused (see migration 009's own comment) — plain text, no PostGIS dependency needed
  external_codes    text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE region_species (
  region_id         uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  species_id        uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  local_frequency   numeric NULL,
  seasonality       numeric[] NULL,
  PRIMARY KEY (region_id, species_id)
);
