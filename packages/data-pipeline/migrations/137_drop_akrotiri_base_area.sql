-- Akrotiri (Natural Earth's WSB, a British base area on Cyprus's south coast) was listed as a
-- country, with a province of the same name. Its sister base area, Dhekelia, was already folded
-- into Cyprus (regionBoundary.ts FOLD_INTO_REAL_COUNTRY), and Akrotiri now is too: its species
-- are Cyprus's, and GBIF records there carry Cyprus's country code.
--
-- Catalog updates never delete a region (an install also creates its own), so this removes it
-- here. Its checklist, hotspots and other catalog rows cascade. A region a user's photos, own
-- additions, hidden species or tier choices point at is left alone rather than lose them, and so
-- is the base area itself while any of its provinces is.
CREATE TEMP TABLE akrotiri_regions ON COMMIT DROP AS
SELECT r.id, r.parent_id, 'WSB' = ANY (r.external_codes) AS is_base_area,
  (EXISTS (SELECT 1 FROM captures_all c WHERE c.region_id = r.id)
    OR EXISTS (SELECT 1 FROM region_species_user_added a WHERE a.region_id = r.id)
    OR EXISTS (SELECT 1 FROM region_species_hidden h WHERE h.region_id = r.id)
    OR EXISTS (SELECT 1 FROM user_tier_overrides t WHERE t.region_id = r.id)) AS has_user_data
FROM regions r
WHERE 'WSB' = ANY (r.external_codes)
  OR r.parent_id IN (SELECT id FROM regions WHERE 'WSB' = ANY (external_codes));

DELETE FROM regions WHERE id IN (SELECT id FROM akrotiri_regions WHERE NOT is_base_area AND NOT has_user_data);

DELETE FROM regions r
USING akrotiri_regions a
WHERE r.id = a.id AND a.is_base_area AND NOT a.has_user_data
  AND NOT EXISTS (SELECT 1 FROM regions child WHERE child.parent_id = r.id);
