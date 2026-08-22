-- Real MDD flag for fully domesticated mammals (cattle, goats, sheep, etc.) — see
-- conversation: rarity axes don't semantically apply to a domesticated animal (its GBIF
-- record count reflects how often people photograph farm animals for citizen science, not
-- how "rare" it is), so it's tracked as a fact rather than baked into the score, and rarity
-- computation forces domestic species to a fixed "common" tier instead of feeding them
-- through the same percentile ranking as wild species.
ALTER TABLE species_traits ADD COLUMN domestic boolean NOT NULL DEFAULT false;
