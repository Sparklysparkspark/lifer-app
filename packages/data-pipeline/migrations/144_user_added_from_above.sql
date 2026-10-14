-- A hand-added species (Other Taxa) you add to a country's checklist shows on each of its provinces
-- or states too (and on the regions inside those), except where iNaturalist has no records of it:
-- the nearest region on the way up with iNaturalist data (inat_region_taxon_data, migration 142)
-- decides, and a region with no data at all keeps it, since nothing rules it out. Catalog species
-- don't pass down: their province checklists already come from iNaturalist sightings, so adding one
-- by hand records a vagrant where it was seen, and it stays there.
--
-- user_added_from_above(user, region) lists the user's additions on regions above `region`, as
-- (species_id, region_id of the addition), with those exclusions applied.
CREATE OR REPLACE FUNCTION user_added_from_above(p_user uuid, p_region uuid)
RETURNS TABLE (species_id uuid, region_id uuid)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up AS (
    -- `below`: the regions from p_region up to, not including, this one, nearest first.
    SELECT r.id, r.parent_id, ARRAY[]::uuid[] AS below FROM regions r WHERE r.id = p_region
    UNION ALL
    SELECT r.id, r.parent_id, up.below || up.id FROM regions r JOIN up ON r.id = up.parent_id
  )
  SELECT a.species_id, a.region_id
    FROM up
    JOIN region_species_user_added a ON a.region_id = up.id AND a.user_id = p_user
    JOIN species s ON s.id = a.species_id AND s.is_other_taxa
   WHERE cardinality(up.below) > 0
     AND NOT EXISTS (
       SELECT 1 FROM (
         SELECT d.weekly_frequency
           FROM unnest(up.below) WITH ORDINALITY AS b(region_id, nearness)
           JOIN inat_region_taxon_data d ON d.region_id = b.region_id AND d.species_id = a.species_id
          ORDER BY b.nearness
          LIMIT 1
       ) nearest
       WHERE nearest.weekly_frequency IS NULL
     )
$$;

-- For those, an addition on a region inside one you've also added the species to says nothing more,
-- so it's folded into the larger one ("Added by you to Canada" rather than a list of provinces).
-- Adding to a region does the same from now on (checklistAdditions.ts).
WITH RECURSIVE inside AS (
  SELECT a.user_id, a.species_id, a.region_id AS outer_id, r.id
    FROM region_species_user_added a
    JOIN species s ON s.id = a.species_id AND s.is_other_taxa
    JOIN regions r ON r.parent_id = a.region_id
  UNION ALL
  SELECT inside.user_id, inside.species_id, inside.outer_id, r.id
    FROM inside JOIN regions r ON r.parent_id = inside.id
)
DELETE FROM region_species_user_added a
 USING inside
 WHERE a.user_id = inside.user_id AND a.species_id = inside.species_id AND a.region_id = inside.id;
