-- Distinguishes an overseas territory province (e.g. France's "Guyane française") from an
-- ordinary one (e.g. "Bretagne") — set from Natural Earth admin1's own `type` field via a
-- curated matcher (fetchProvincesForCountry), not a blind heuristic. Used to default a freshly
-- downloaded country pack's applied_province_region_ids to exclude these rather than requiring
-- the user to manually offload each one after the fact.
ALTER TABLE regions ADD COLUMN is_overseas_territory boolean NOT NULL DEFAULT false;
