-- A species that science split into several (iNaturalist retired the old taxon and replaced it with
-- two or more). The old entry can stay in the catalog, often still valid for part of its old range
-- (Phrynosoma coronatum is now only Baja's horned lizard; California's is P. blainvillii). Your
-- photos filed under it are re-filed by where they were taken (species/speciesSplits.ts), and the
-- ones that can't be settled by place ask you to pick instead of showing tags that no longer fit.
CREATE TABLE species_splits (
  parent_species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  daughter_species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'inaturalist',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_species_id, daughter_species_id),
  CHECK (parent_species_id <> daughter_species_id)
);
CREATE INDEX species_splits_daughter_idx ON species_splits (daughter_species_id);

-- Photos their owner confirmed are the old species after all (picked "Keep" on the card), so the
-- card stops asking. Per photo: another photo of the same species may still need settling.
CREATE TABLE species_split_kept (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  kept_at timestamptz NOT NULL DEFAULT now()
);
