-- Unlinking a photo found on iNaturalist undoes exactly what the link wrote. link_writes records
-- it per link row, as inaturalist/unlink.ts builds it: each field the write-back filled (lat, lon,
-- location_source, location_accuracy_m, region_id, taken_at) with its value before and after, and
-- whether the photo's files were rewritten. NULL: Lifer sent the observation, or nothing was written.
ALTER TABLE capture_inaturalist_observations ADD COLUMN link_writes jsonb;

-- A remembered pair is either the user's Not a match (never suggested again) or an Unlink (still
-- suggested for review, but never linked again by itself).
ALTER TABLE capture_inaturalist_not_matches
  ADD COLUMN kind text NOT NULL DEFAULT 'not_match' CHECK (kind IN ('not_match', 'unlinked'));
