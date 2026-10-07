-- The interface language each account picked in Settings > General. NULL means automatic: follow
-- the browser or system language. The web app resolves the code against the translations it
-- ships (apps/web/src/i18n), so the server only checks it is a well-formed language tag.
ALTER TABLE users ADD COLUMN locale text;
