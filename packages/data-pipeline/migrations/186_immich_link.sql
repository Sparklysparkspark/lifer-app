-- Immich as a photo source on a server (apps/api/src/integrations/immich). Originals stay in
-- Immich and are read through its API; Lifer keeps the capture and its derivatives.

-- One linked Immich server per user. api_key is encrypted with the server's at-rest key
-- (lib/secretBox.ts), never stored as plain text.
CREATE TABLE immich_links (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  server_url      text NOT NULL,
  api_key         text NOT NULL,
  server_version  text NOT NULL,
  album_ids       text[] NOT NULL DEFAULT '{}',
  -- Writing confirmed species back to Immich as tags is opt-in.
  write_tags      boolean NOT NULL DEFAULT false,
  last_sync_at    timestamptz,
  last_error      text,
  linked_at       timestamptz NOT NULL DEFAULT now()
);

-- Every Immich asset a sync has looked at, so the next one only reads what changed.
-- outcome 'imported' or 'duplicate' with a NULL capture_id: the user removed the photo in Lifer,
-- so it is never brought in again. 'unrecognized' is retried when Immich's updated time changes.
-- tagged_as: the tag Lifer last wrote on the asset, so a changed species moves its tag.
CREATE TABLE immich_assets (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  immich_asset_id    text NOT NULL,
  capture_id         uuid REFERENCES captures_all(id) ON DELETE SET NULL,
  immich_updated_at  timestamptz NOT NULL,
  checksum           text NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('imported', 'duplicate', 'unrecognized', 'skipped')),
  tagged_as          text,
  PRIMARY KEY (user_id, immich_asset_id)
);
CREATE INDEX immich_assets_capture_idx ON immich_assets (capture_id) WHERE capture_id IS NOT NULL;
CREATE INDEX immich_assets_checksum_idx ON immich_assets (user_id, checksum);
