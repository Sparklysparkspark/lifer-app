-- Share link tokens are now found by their sha256 in hex, like sessions (109) and API keys, so a
-- copy of the database can't open live shares. Existing rows are hashed in place, so every link
-- already handed out keeps working (apps/api/src/shares/routes.ts hashes the token in the URL).
ALTER TABLE shared_links ADD COLUMN token_hash text;
UPDATE shared_links SET token_hash = encode(digest(token, 'sha256'), 'hex');
ALTER TABLE shared_links ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE shared_links ADD CONSTRAINT shared_links_token_hash_key UNIQUE (token_hash);

-- The owner can still copy a link from the album's share list: that copy is kept encrypted with
-- the server's key, which lives outside the database (apps/api/src/lib/secretBox.ts). The key
-- can't be used here, so the API moves each remaining plain token into token_encrypted, and
-- clears it, when it starts (encryptStoredShareTokens).
ALTER TABLE shared_links ADD COLUMN token_encrypted text;
ALTER TABLE shared_links ALTER COLUMN token DROP NOT NULL;
