-- iNaturalist observation sync (ported from feature/inaturalist-sync, renumbered from that
-- branch's own 048 to avoid colliding with main's real 048_province_split_meaningful.sql, which
-- didn't exist yet when this branch was cut). Two tables: one holding the linked account's OAuth
-- tokens, one tracking which captures have been submitted as draft observations and whether the
-- user has since gone back to iNaturalist and actually refined the coarse location we sent.

CREATE TABLE user_inaturalist_accounts (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token   text NOT NULL,
  -- Nullable: iNaturalist's OAuth token response may or may not include one — store whatever
  -- comes back rather than assuming either way.
  refresh_token  text NULL,
  inat_user_id   text NOT NULL,
  inat_username  text NOT NULL,
  connected_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capture_inaturalist_observations (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One capture can only ever be part of one submitted observation — UNIQUE rather than a
  -- plain index makes "already submitted" a constraint the DB enforces, not just a query the
  -- Import tab happens to run.
  -- captures is a view (soft-delete trash, see migration 061) — FKs need the real underlying
  -- table, same convention migration 071 already established.
  capture_id                     uuid NOT NULL UNIQUE REFERENCES captures_all(id) ON DELETE CASCADE,
  inat_observation_id            text NOT NULL,
  -- What we actually sent as the observation's location, so "Confirm Complete" can tell a
  -- user-refined location apart from the coarse region-level guess it started as.
  submitted_lat                  numeric NOT NULL,
  submitted_lon                  numeric NOT NULL,
  submitted_positional_accuracy  numeric NOT NULL,
  status                         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  confirmed_at                   timestamptz NULL
);

CREATE INDEX idx_capture_inaturalist_observations_status ON capture_inaturalist_observations (status);

-- Deployment-wide (not per-user) override of config.ts's INAT_CLIENT_ID/INAT_REDIRECT_URI env
-- vars — a server-mode admin registers their own iNaturalist application (its redirect URI has
-- to be that deployment's real domain, which no single shared registration could ever cover) and
-- pastes the client ID in from Settings instead of editing an env file and restarting. Singleton
-- row (id always true) rather than a generic key/value table, since this is the only
-- deployment-wide config Lifer has so far — not worth a more general mechanism for one setting.
CREATE TABLE inat_server_config (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  client_id     text NULL,
  redirect_uri  text NULL
);
