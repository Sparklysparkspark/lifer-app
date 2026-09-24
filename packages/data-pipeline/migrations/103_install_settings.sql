-- Per-install key/value settings. The catalog is shared by every account on an install, so which
-- catalog seed version has been applied (and which gallery embeddings version) belongs here, not
-- on users: with it on users, a second account saw "catalog update available" for a catalog the
-- install already had.
CREATE TABLE install_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO install_settings (key, value)
SELECT 'catalog_seed_version', to_jsonb(max(catalog_seed_version))
FROM users
HAVING max(catalog_seed_version) IS NOT NULL;
