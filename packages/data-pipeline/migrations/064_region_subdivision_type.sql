-- Raw Natural Earth admin-1 "type" property (e.g. "State", "Region", "Province", "Oblast",
-- "Prefecture") for a country's child regions — lets the UI say "States"/"Regions"/"Provinces"
-- per country instead of always "Provinces", without guessing from the country itself (some
-- countries' own admin-1 features are inconsistently typed, so this is stored per-child, not
-- assumed at the country level).
ALTER TABLE regions ADD COLUMN subdivision_type text NULL;
