-- An unlinked RAW original (capture_id NULL) has no capture to derive ownership from yet —
-- the indexing job sets this from the scan_root that discovered it, so the review UI (assign
-- a species, or just list "your" unassigned RAWs) can be scoped per user like everything
-- else. Once linked to a capture, ownership is really captures.user_id; this stays populated
-- for consistency but isn't the source of truth after that point.
ALTER TABLE originals ADD COLUMN user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE;
