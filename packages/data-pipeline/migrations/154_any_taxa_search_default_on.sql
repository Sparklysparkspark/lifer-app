-- Searching iNaturalist for species Lifer has no dataset for is on unless the user turns it off:
-- the setting says searches go to iNaturalist, which is the notice the trust model asks for.
-- Existing accounts never chose otherwise (it was off by default), so they get the new default.
ALTER TABLE users ALTER COLUMN any_taxa_search_enabled SET DEFAULT true;
UPDATE users SET any_taxa_search_enabled = true WHERE NOT any_taxa_search_enabled;
