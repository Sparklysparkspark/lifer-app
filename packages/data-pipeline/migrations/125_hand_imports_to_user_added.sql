-- Hand-imported (Other Taxa) species used to be put on a region's checklist with a row in the
-- shared region_species table. That gave them no "Added by you" marker, and removing one deleted
-- it for everyone on the server. They now live in region_species_user_added (migration 124), per
-- user, like any other species added to a checklist by hand. This moves the old rows across.
--
-- Who gets each one: every user. Nothing recorded who imported a species (region_species has no
-- user column, and any_taxa_search_enabled can be switched off again), and a shared row showed on
-- that region's checklist for every user, so every user gets it to keep seeing exactly what they
-- saw before. On a single-user install, which is most of them, that's simply the importer. A user
-- who had hidden one in a region keeps the hide (region_species_hidden is left alone), so it stays
-- hidden there; one who never wanted it can remove it for themselves alone now.
--
-- Only species marked is_other_taxa move. A hand import that matched a catalog species by GBIF key
-- wrote a region_species row indistinguishable from the catalog's own, so those stay where they are.
-- No import time was recorded either, so added_at is when this migration ran.
INSERT INTO region_species_user_added (user_id, region_id, species_id)
SELECT u.id, rs.region_id, rs.species_id
FROM region_species rs
JOIN species s ON s.id = rs.species_id AND s.is_other_taxa
CROSS JOIN users u
ON CONFLICT (user_id, region_id, species_id) DO NOTHING;

-- Other Taxa never have hotspots or anything else hanging off a region_species row, so the rows
-- can simply go.
DELETE FROM region_species rs
USING species s
WHERE s.id = rs.species_id AND s.is_other_taxa;
