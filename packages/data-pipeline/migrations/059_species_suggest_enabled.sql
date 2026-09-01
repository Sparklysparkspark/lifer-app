-- Species auto-suggest is on by default (Phase 2 of the auto-suggest plan — it's purely local,
-- nothing ever leaves the device, so there's no privacy reason to gate it). This toggle exists
-- for a different reason: the feature is labeled "Experimental" in the UI, and some users may
-- simply not want the suggestion cards while it's still being tuned — same shape as
-- hide_obscure_species (migration 038), a persisted account preference rather than a per-view
-- filter.
ALTER TABLE users ADD COLUMN species_suggest_enabled boolean NOT NULL DEFAULT true;
