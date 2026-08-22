-- Durable, per-capture record of what's already been pushed to which server. A capture only
-- ever gets a 'migrated' row here AFTER the remote server confirms the upload succeeded, so
-- re-running the migration (after a dropped connection, a closed app, a server restart —
-- anything short of this row itself lying) always picks up exactly where it left off:
-- already-migrated and permanently-skipped captures aren't retried, but a 'failed' one is,
-- since that's the one outcome that might just have been a transient network blip.
CREATE TABLE capture_migrations (
  capture_id  uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  server_url  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('migrated', 'skipped', 'failed')),
  migrated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, server_url)
);
