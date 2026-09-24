-- A storage volume can now be a folder a self-hosted admin bind-mounted into the container and
-- declared in LIFER_LIBRARY_ROOTS (kind 'root'), not only a physical drive the desktop app
-- detected by its UUID (kind 'drive'). Inside a container a bind mount has no visible drive
-- identity, so drive detection can't work there; a root is just a labeled folder that files are
-- stored relative to, which is all the rest of the volume system ever needed.
--
-- Same table as drives so originals.volume_id and every storage_volumes join keeps working.
-- Roots belong to the install, not an account, so user_id is NULL for them. A root removed from
-- the env is kept with removed_at set (never deleted), so its files read as "not connected"
-- instead of silently losing their volume, and re-adding the same path revives them.
ALTER TABLE storage_volumes
  ADD COLUMN kind text NOT NULL DEFAULT 'drive',
  ADD COLUMN root_path text NULL,
  ADD COLUMN removed_at timestamptz NULL;

ALTER TABLE storage_volumes ADD CONSTRAINT storage_volumes_kind_check CHECK (kind IN ('drive', 'root'));

ALTER TABLE storage_volumes ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE storage_volumes ALTER COLUMN platform_volume_id DROP NOT NULL;

ALTER TABLE storage_volumes ADD CONSTRAINT storage_volumes_kind_shape CHECK (
  (kind = 'drive' AND user_id IS NOT NULL AND platform_volume_id IS NOT NULL AND root_path IS NULL)
  OR (kind = 'root' AND user_id IS NULL AND platform_volume_id IS NULL AND root_path IS NOT NULL)
);

-- is_default is a per-user preference (one per user, migration 051); a root has no user.
ALTER TABLE storage_volumes ADD CONSTRAINT storage_volumes_root_never_default CHECK (kind = 'drive' OR is_default = false);

-- The inline UNIQUE (user_id, platform_volume_id) from migration 050 becomes a per-kind partial
-- index. Looked up by definition rather than assuming Postgres's generated name.
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'storage_volumes'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, platform_volume_id)';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE storage_volumes DROP CONSTRAINT %I', c);
  END IF;
END $$;

CREATE UNIQUE INDEX storage_volumes_drive_identity ON storage_volumes (user_id, platform_volume_id) WHERE kind = 'drive';
CREATE UNIQUE INDEX storage_volumes_root_path ON storage_volumes (root_path) WHERE kind = 'root';
