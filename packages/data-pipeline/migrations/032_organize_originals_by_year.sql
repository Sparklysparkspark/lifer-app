-- An opt-in alternate layout for store-mode originals — instead of the flat
-- <species>/RAW|Adjusted tree, files land in Wildlife <year>/<Birds|Mammals|Fish>/
-- <species>/RAW|Adjusted, so an external tool (Immich, Finder, whatever) sees something
-- meaningfully organized without ever opening Lifer. Single-user app, so this lives on the
-- one users row rather than a separate settings table.
ALTER TABLE users ADD COLUMN organize_originals_by_year boolean NOT NULL DEFAULT false;
