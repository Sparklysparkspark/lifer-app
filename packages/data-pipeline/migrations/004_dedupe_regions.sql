-- load-seed.ts's regions insert had no ON CONFLICT, so re-running it against an
-- already-loaded database (which happened several times during dev) created a duplicate
-- "British Columbia" row per run, each with its own region_species rows pointing at it.
-- Clean up the duplicates, then add a real uniqueness constraint so this can't recur —
-- load-seed.ts now upserts on region name instead of blindly inserting.

DELETE FROM region_species
WHERE region_id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn FROM regions
  ) ranked WHERE rn > 1
);

DELETE FROM regions
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn FROM regions
  ) ranked WHERE rn > 1
);

ALTER TABLE regions ADD CONSTRAINT regions_name_key UNIQUE (name);
