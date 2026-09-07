-- Tracks whether a species has already gone through the GBIF-distributions-based
-- vagrant cross-check (verify-vagrant-flags.ts) — mirrors endemic_checked_at's
-- idempotency pattern (041_endemic_region_label.sql) so a killed/resumed run
-- doesn't re-spend GBIF calls on species already checked.
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS vagrant_checked_at timestamptz NULL;
