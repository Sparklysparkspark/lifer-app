-- One portfolio per user: what goes into the static site and public life list, and the hash of its
-- current share link (server only). The link itself is shown once when made; a new one replaces it.
CREATE TABLE portfolios (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spec             jsonb NOT NULL,
  share_token_hash text UNIQUE,
  shared_at        timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
