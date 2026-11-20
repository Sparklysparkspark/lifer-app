-- The old percentile scores no longer decide any tier (compute-global-tiers.ts writes the tier
-- straight from the local ones). Nullable so they can be dropped later; the default keeps
-- species_rarity.composite a number for the readers that still select it.
ALTER TABLE species_rarity
  ALTER COLUMN range_score DROP NOT NULL,
  ALTER COLUMN range_score SET DEFAULT 0,
  ALTER COLUMN abundance_score DROP NOT NULL,
  ALTER COLUMN abundance_score SET DEFAULT 0,
  ALTER COLUMN composite DROP NOT NULL,
  ALTER COLUMN composite SET DEFAULT 0;
