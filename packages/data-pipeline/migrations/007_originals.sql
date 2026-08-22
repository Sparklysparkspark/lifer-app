-- Pulls spec §6/§8.4's originals model forward for this self-hosted, single-user deployment,
-- where full-resolution originals are worth keeping rather than discarding after deriving a
-- display copy. Two modes: `managed=true` means Lifer wrote and owns this file (store mode);
-- `managed=false` means it's an external reference Lifer never writes to or deletes (link
-- mode, picked via a native Finder dialog).

CREATE TABLE originals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id   uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('raw', 'jpeg')),
  ref_type     text NOT NULL CHECK (ref_type IN ('path', 'immich', 's3')),
  ref          text NOT NULL,
  managed      boolean NOT NULL,
  content_hash text NOT NULL,
  file_size    bigint NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, kind)
);
