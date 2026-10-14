-- Countries browse as country > vernacular group > province where they have familiar groupings
-- (packages/data-pipeline/src/build/vernacular-regions-data.ts). The province build re-created
-- every grouped province directly under its country, leaving a frozen copy of each inside its
-- group. This removes those copies; the pipeline's vernacular sync then nests the live provinces
-- under their groups, and installs pick that up with the next catalog update.
--
-- A copy is a childless region inside a group (a child of a country) with a same-named childless
-- region directly under that country, its live twin. A province that shares its group's name
-- (Hungary's counties) has no twin and stays. User data on a copy moves to its twin first.

-- A province shown under its continent rather than its country (the Galapagos pattern) is still
-- that country's for its checklist, tiers and data; this names the country. Set by the pipeline.
ALTER TABLE regions ADD COLUMN home_country_id uuid;

CREATE TEMP TABLE stale_province_copies ON COMMIT DROP AS
SELECT copy.id AS copy_id, twin.id AS twin_id, grp.id AS group_id
FROM regions w
JOIN regions cont ON cont.parent_id = w.id
JOIN regions country ON country.parent_id = cont.id
JOIN regions grp ON grp.parent_id = country.id
JOIN regions copy ON copy.parent_id = grp.id
JOIN regions twin ON twin.parent_id = country.id AND twin.name = copy.name AND twin.id <> grp.id
WHERE w.parent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = copy.id)
  AND NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = twin.id);

UPDATE captures_all c SET region_id = s.twin_id FROM stale_province_copies s WHERE c.region_id = s.copy_id;

INSERT INTO region_species_user_added (user_id, region_id, species_id, added_at)
SELECT a.user_id, s.twin_id, a.species_id, a.added_at
FROM region_species_user_added a JOIN stale_province_copies s ON s.copy_id = a.region_id
ON CONFLICT DO NOTHING;

INSERT INTO region_species_hidden (user_id, region_id, species_id, hidden_at)
SELECT h.user_id, s.twin_id, h.species_id, h.hidden_at
FROM region_species_hidden h JOIN stale_province_copies s ON s.copy_id = h.region_id
ON CONFLICT DO NOTHING;

INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier, created_at)
SELECT t.user_id, s.twin_id, t.species_id, t.tier, t.created_at
FROM user_tier_overrides t JOIN stale_province_copies s ON s.copy_id = t.region_id
ON CONFLICT DO NOTHING;

-- Reviewed by hand, so worth keeping too.
INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source, verified_at, is_invasive)
SELECT s.twin_id, o.species_id, o.is_vagrant, o.source, o.verified_at, o.is_invasive
FROM region_species_manual_overrides o JOIN stale_province_copies s ON s.copy_id = o.region_id
ON CONFLICT DO NOTHING;

UPDATE downloaded_packs d
SET applied_province_region_ids = (
  SELECT jsonb_agg(DISTINCT COALESCE(s.twin_id::text, e.id))
  FROM jsonb_array_elements_text(d.applied_province_region_ids) AS e(id)
  LEFT JOIN stale_province_copies s ON s.copy_id::text = e.id
)
WHERE jsonb_typeof(d.applied_province_region_ids) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(d.applied_province_region_ids) AS e(id)
    JOIN stale_province_copies s ON s.copy_id::text = e.id
  );

-- Checklists, hotspots and the rest of the copies' catalog rows cascade.
DELETE FROM regions r USING stale_province_copies s WHERE r.id = s.copy_id;

-- A group left empty reads as a place of its own until its provinces are nested back under it.
UPDATE regions g SET has_children = false
WHERE g.id IN (SELECT group_id FROM stale_province_copies)
  AND NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = g.id);
