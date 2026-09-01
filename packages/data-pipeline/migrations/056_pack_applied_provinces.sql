-- NULL means "every province is applied" (today's behavior, and the default for every existing
-- pack) — only ever becomes a real array once a user deliberately narrows a country pack down
-- to a subset of its provinces (Fix 8: province-level selection within a country pack).
ALTER TABLE downloaded_packs ADD COLUMN applied_province_region_ids jsonb NULL;
