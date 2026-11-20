-- A key a companion app got by pairing (apps/api/src/plugins/pairing.ts) names the app, so pairing
-- again replaces that app's key instead of adding one, and a launch the user already allowed pairs
-- without asking. Revoking the key (deleting the row) means the next pairing asks again.
ALTER TABLE api_keys ADD COLUMN plugin_id text NULL;

CREATE UNIQUE INDEX api_keys_user_plugin ON api_keys (user_id, plugin_id) WHERE plugin_id IS NOT NULL;
