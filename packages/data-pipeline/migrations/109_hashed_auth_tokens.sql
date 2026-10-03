-- Sessions and password reset tokens are now stored as sha256(token) in hex, so a leaked
-- database or backup can't be replayed as a login. Existing rows are hashed in place (pgcrypto
-- is enabled in 001), so nobody gets signed out by this change.
UPDATE sessions SET id = encode(digest(id, 'sha256'), 'hex');
UPDATE password_reset_tokens SET token = encode(digest(token, 'sha256'), 'hex');

-- For the daily cleanup of expired rows (lib/maintenance.ts).
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens (expires_at);
