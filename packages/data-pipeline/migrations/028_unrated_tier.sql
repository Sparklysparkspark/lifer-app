-- Mammals/fish with zero real distinguishing data were getting fanned across every tier
-- including "legendary" by an arbitrary tie-break, since the percentile-quota system has to
-- put a huge tied "no data at all" block somewhere. A new 'unrated' tier value covers species
-- with no real signal at all, instead of forcing them into the 5-tier difficulty ladder. See
-- apply-rarity-phase4.ts for where this is assigned.
ALTER TABLE species_rarity DROP CONSTRAINT species_rarity_tier_check;
ALTER TABLE species_rarity ADD CONSTRAINT species_rarity_tier_check
  CHECK (tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'unrated'));
