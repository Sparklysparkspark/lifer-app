-- Regional rarity (spec §7: local likelihood is a separate display on the region view, never
-- on the card). The global species_rarity.tier stays fixed and
-- comparable between users; this is a second, region-scoped read computed by ranking each
-- species' local_frequency against every other species actually in that region's checklist,
-- so a country with unusually heavy birding effort can't skew it the way weighting the
-- GLOBAL elusiveness score by total per-country record volume already can.
ALTER TABLE region_species ADD COLUMN local_tier text NULL
  CHECK (local_tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary'));
