-- Desktop-only multi-drive support (see ~/.claude/plans/multi-drive-storage.md): a photographer
-- without a NAS often spreads their library across several external drives instead. Each
-- registered drive gets one row here, keyed by a STABLE platform volume identifier (macOS:
-- Volume UUID from `diskutil info`) rather than its mount path — a drive can mount at a
-- different path next time it's plugged in (a different name taken, a different drive letter
-- on Windows), and the whole point of this table is recognizing "this is the same drive I saw
-- before" across that.
CREATE TABLE storage_volumes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                  text NOT NULL,
  platform_volume_id     text NOT NULL,
  last_known_mount_path  text NOT NULL,
  last_seen_at           timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform_volume_id)
);

-- Nullable: every existing original (and every future store-mode/primary-DATA_DIR original)
-- has no separate volume — NULL means "resolve `ref` as a plain absolute path, same as today."
-- When set, `ref` is refreshed opportunistically to the last-known-good absolute path (a cache,
-- not the source of truth), and `volume_relative_path` is the real source of truth: the path
-- relative to that volume's own mount root, computed once when the file was first linked, used
-- to re-derive a fresh absolute path whenever the volume reconnects at a different mount point.
ALTER TABLE originals ADD COLUMN volume_id uuid NULL REFERENCES storage_volumes(id) ON DELETE SET NULL;
ALTER TABLE originals ADD COLUMN volume_relative_path text NULL;
