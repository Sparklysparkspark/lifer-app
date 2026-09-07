-- Personal API keys for server/self-hosted installs to build their own integrations against
-- (a Home Assistant dashboard, a backup script, a static site) — see apps/api/src/auth/apiKeys.ts
-- and requireScope in auth/session.ts. Desktop mode never surfaces the management UI (no real
-- session system to protect it, no public address to hand a key out to), but the table exists
-- unconditionally same as shared_links.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- sha256 hex digest of the raw token, never the token itself — see apiKeys.ts's own comment
  -- on why a fast hash (not argon2) is the right choice for a high-entropy random token checked
  -- on every request.
  key_hash      text NOT NULL UNIQUE,
  permissions   text[] NOT NULL,
  last_used_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_user ON api_keys (user_id);
