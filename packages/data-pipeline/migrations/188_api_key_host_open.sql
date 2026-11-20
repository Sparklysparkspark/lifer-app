-- A paired app's "open inside Lifer from now on" preference (apps/api/src/plugins/hostPreference.ts).
-- Lives on the app's key so revoking the app forgets it. Only the user's own confirmation sets it.
ALTER TABLE api_keys ADD COLUMN host_open boolean NOT NULL DEFAULT false;
