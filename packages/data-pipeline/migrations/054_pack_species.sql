-- Tracks which species each downloaded pack actually delivered enrichment data for
-- (photo/habitat text), separately from region_species/sea_zone_species checklist membership
-- (which stays keyed by region/sea-zone, not by pack — a region's checklist facts don't need
-- "undoing" the way a shared photo file does). This is the reference-counting table that makes
-- safe pack deletion possible: a species' reference_display_path/reference_thumb_path can only
-- be deleted from disk (and enriched_at cleared) once NO row remains here for it across every
-- OTHER still-downloaded pack, AND the user has no capture of it themselves (checked directly
-- against user_species — no new column needed for that half).
CREATE TABLE pack_species (
  pack_id             text NOT NULL REFERENCES downloaded_packs(pack_id) ON DELETE CASCADE,
  species_id          uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  -- true only when THIS pack's own download is what actually wrote the reference photo/habitat
  -- text (false when applyChecklist found the species already enriched by another pack and
  -- skipped the copy) — only provided_enrichment=true rows count toward "does some pack still
  -- need these files" when a different pack is later deleted.
  provided_enrichment boolean NOT NULL DEFAULT false,
  PRIMARY KEY (pack_id, species_id)
);

CREATE INDEX idx_pack_species_species ON pack_species (species_id);
