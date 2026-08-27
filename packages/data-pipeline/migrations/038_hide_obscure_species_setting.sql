-- Moves "hide obscure/inaccessible species" from a per-view URL toggle (easy to miss, and
-- redundant to re-decide on every region) into a persisted account preference, set once from
-- the Settings page — same pattern as organize_originals_by_year (migration 032).
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_obscure_species boolean NOT NULL DEFAULT true;
