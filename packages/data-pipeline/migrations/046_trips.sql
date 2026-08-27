-- Persistent "Trip" grouping for reference-in-place wildlife folders (e.g. a "Wildlife"
-- subfolder inside an external "Costa Rica 2026" trip archive) — see apps/api/src/trips/ for
-- the scan/import/rescan logic. One trip per capture (nullable): no evidence a capture needs
-- to belong to more than one trip.
--
-- Supersedes migration 013's scan_roots/fingerprint_collisions design (a generic, never-wired-
-- up "watch a root folder" concept) with something simpler and 1:1 with a trip:
-- source_folder IS the scan root, no separate table needed. fingerprint_collisions itself
-- needs no schema change — it already just references an original_id — and gets its first real
-- use here for trip rescans.
CREATE TABLE trips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  source_folder    text NOT NULL,
  cover_capture_id uuid NULL REFERENCES captures(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE captures ADD COLUMN trip_id uuid NULL REFERENCES trips(id) ON DELETE SET NULL;
CREATE INDEX idx_captures_trip_id ON captures (trip_id) WHERE trip_id IS NOT NULL;
