-- Archive health: a per-file baseline separate from content_hash (the import identity), which
-- drifts once Lifer embeds metadata into a file.
ALTER TABLE originals
  ADD COLUMN IF NOT EXISTS verified_hash  text NULL,
  ADD COLUMN IF NOT EXISTS verified_mtime timestamptz NULL,
  ADD COLUMN IF NOT EXISTS checked_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS health         text NULL CHECK (health IN ('changed', 'unreadable', 'missing', 'ignored'));

-- Lifer never writes into a RAW (sidecars only), so its import hash is still a valid baseline.
UPDATE originals SET verified_hash = content_hash
WHERE kind = 'raw' AND lower(ref) !~ '\.dng$' AND verified_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_originals_checked_at ON originals (checked_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_originals_health ON originals (user_id, health) WHERE health IS NOT NULL;
