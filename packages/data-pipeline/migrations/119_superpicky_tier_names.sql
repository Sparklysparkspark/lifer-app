-- Rarity tiers take SuperPicky's five names and meanings: Common (everyday, anywhere), Occasional
-- (if you go to the right habitat), Uncommon (a dedicated search), Rare (travel and patience),
-- Legendary (once in a lifetime). "Epic" is gone. The bands keep their order, so each stored tier
-- moves up a name in one pass: uncommon becomes occasional, rare becomes uncommon, epic becomes
-- rare. Tier explanations carry the base tier too.
ALTER TABLE region_species DROP CONSTRAINT IF EXISTS region_species_local_tier_check;
ALTER TABLE sea_zone_species DROP CONSTRAINT IF EXISTS sea_zone_species_local_tier_check;
ALTER TABLE species_rarity DROP CONSTRAINT IF EXISTS species_rarity_tier_check;
ALTER TABLE user_tier_overrides DROP CONSTRAINT IF EXISTS user_tier_overrides_tier_check;

CREATE FUNCTION pg_temp.renamed_tier(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE t WHEN 'uncommon' THEN 'occasional' WHEN 'rare' THEN 'uncommon' WHEN 'epic' THEN 'rare' ELSE t END
$$;
CREATE FUNCTION pg_temp.renamed_explain(e jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN e ? 'base' AND jsonb_typeof(e->'base') = 'string'
              THEN jsonb_set(e, '{base}', to_jsonb(pg_temp.renamed_tier(e->>'base')))
              ELSE e END
$$;

UPDATE region_species SET local_tier = pg_temp.renamed_tier(local_tier) WHERE local_tier IN ('uncommon', 'rare', 'epic');
UPDATE region_species SET tier_explain = pg_temp.renamed_explain(tier_explain) WHERE tier_explain->>'base' IN ('uncommon', 'rare', 'epic');
UPDATE sea_zone_species SET local_tier = pg_temp.renamed_tier(local_tier) WHERE local_tier IN ('uncommon', 'rare', 'epic');
UPDATE sea_zone_species SET tier_explain = pg_temp.renamed_explain(tier_explain) WHERE tier_explain->>'base' IN ('uncommon', 'rare', 'epic');
UPDATE species_rarity SET tier = pg_temp.renamed_tier(tier) WHERE tier IN ('uncommon', 'rare', 'epic');
UPDATE species_rarity SET tier_explain = pg_temp.renamed_explain(tier_explain) WHERE tier_explain->>'base' IN ('uncommon', 'rare', 'epic');
UPDATE user_tier_overrides SET tier = pg_temp.renamed_tier(tier) WHERE tier IN ('uncommon', 'rare', 'epic');

ALTER TABLE region_species ADD CONSTRAINT region_species_local_tier_check
  CHECK (local_tier IN ('common', 'occasional', 'uncommon', 'rare', 'legendary'));
ALTER TABLE sea_zone_species ADD CONSTRAINT sea_zone_species_local_tier_check
  CHECK (local_tier IN ('common', 'occasional', 'uncommon', 'rare', 'legendary'));
ALTER TABLE species_rarity ADD CONSTRAINT species_rarity_tier_check
  CHECK (tier IN ('common', 'occasional', 'uncommon', 'rare', 'legendary', 'unrated'));
ALTER TABLE user_tier_overrides ADD CONSTRAINT user_tier_overrides_tier_check
  CHECK (tier IN ('common', 'occasional', 'uncommon', 'rare', 'legendary'));
