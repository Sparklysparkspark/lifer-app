-- A pack applies its checklist first and its hotspots in a second transaction. This records the
-- content version whose hotspots landed; when it differs from content_version, the pack is
-- applied again at startup.
ALTER TABLE downloaded_packs ADD COLUMN hotspots_applied_version text;
UPDATE downloaded_packs SET hotspots_applied_version = content_version;
