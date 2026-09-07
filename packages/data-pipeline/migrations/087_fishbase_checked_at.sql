-- Tracks whether a fish species' remaining "needs search" vagrant entries have already gone
-- through the FishBase country-status cross-check (verify-vagrant-fishbase.ts) — same
-- idempotency pattern as vagrant_checked_at (086_vagrant_checked_at.sql).
ALTER TABLE species_traits ADD COLUMN IF NOT EXISTS fishbase_checked_at timestamptz NULL;
