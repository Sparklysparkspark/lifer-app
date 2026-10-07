-- One home for IUCN Red List status: species_traits.iucn_status, stored as the IUCN code.
--
-- Before this, catalog species kept it in species_traits as free text from Wikidata labels
-- ('least concern', 'Data Deficient', 'extinct_in_wild', ...), while species.iucn_status
-- (migration 091) held Title Case names for Other Taxa species only. The detail endpoint selects
-- s.*, t.*, so the traits column shadowed the species one and an Other Taxa species' status
-- never reached the page. backfill-iucn-status.ts wrote species.iucn_status too, but its
-- hardcoded checklist key went stale and it never matched anything.
--
-- Codes (packages/shared/src/iucn.ts): EX EW CR EN VU LR/cd NT LC DD NE.
--   iucn_checked_at  when backfill-iucn-status.ts last looked the species up in the IUCN Red
--                    List. With iucn_status 'NE', IUCN has no assessment of it under any name
--                    or synonym we could find. With iucn_status NULL, the lookup couldn't decide
--                    (a group IUCN assesses comprehensively, so a miss is more likely a naming
--                    gap than a real absence); iucn_note says why.
--   iucn_source      where the status came from: iucn_red_list, wikidata or inaturalist.
--   iucn_note        a short caveat shown with the status, e.g. a split IUCN still assesses as
--                    part of its parent species.
--   iucn_taxon_id    the IUCN Red List taxon id the status was matched to.

ALTER TABLE species_traits
  ADD COLUMN IF NOT EXISTS iucn_checked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS iucn_source text NULL,
  ADD COLUMN IF NOT EXISTS iucn_note text NULL,
  ADD COLUMN IF NOT EXISTS iucn_taxon_id bigint NULL;

-- Mirrors normalizeIucnStatus in packages/shared/src/iucn.ts (an integration test checks they
-- agree). Session-only: nothing after this migration needs it in SQL.
CREATE FUNCTION pg_temp.iucn_code(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN raw IN ('EX', 'EW', 'CR', 'EN', 'VU', 'LR/cd', 'NT', 'LC', 'DD', 'NE') THEN raw
    ELSE (
      SELECT CASE k
        WHEN 'ex' THEN 'EX' WHEN 'extinct' THEN 'EX'
        WHEN 'ew' THEN 'EW' WHEN 'extinct in the wild' THEN 'EW' WHEN 'extinct in wild' THEN 'EW'
        WHEN 'cr' THEN 'CR' WHEN 'critically endangered' THEN 'CR' WHEN 'cr pe' THEN 'CR' WHEN 'cr pew' THEN 'CR'
        WHEN 'en' THEN 'EN' WHEN 'endangered' THEN 'EN'
        WHEN 'vu' THEN 'VU' WHEN 'vulnerable' THEN 'VU'
        WHEN 'lr cd' THEN 'LR/cd' WHEN 'cd' THEN 'LR/cd' WHEN 'conservation dependent' THEN 'LR/cd'
        WHEN 'lower risk conservation dependent' THEN 'LR/cd'
        WHEN 'nt' THEN 'NT' WHEN 'near threatened' THEN 'NT' WHEN 'lr nt' THEN 'NT' WHEN 'lower risk near threatened' THEN 'NT'
        WHEN 'lc' THEN 'LC' WHEN 'least concern' THEN 'LC' WHEN 'lr lc' THEN 'LC' WHEN 'lower risk least concern' THEN 'LC'
        WHEN 'dd' THEN 'DD' WHEN 'data deficient' THEN 'DD'
        WHEN 'ne' THEN 'NE' WHEN 'not evaluated' THEN 'NE'
      END
      FROM (
        SELECT btrim(regexp_replace(regexp_replace(
                 regexp_replace(lower(raw), '\((possibly extinct|possibly extinct in the wild)\)', '', 'g'),
                 '[_/().,:-]+', ' ', 'g'), '\s+', ' ', 'g')) AS k
      ) norm
    )
  END
$$;

-- Every existing catalog value came from a Wikidata label (the build-seed scripts).
UPDATE species_traits
SET iucn_status = pg_temp.iucn_code(iucn_status),
    iucn_source = COALESCE(iucn_source, CASE WHEN pg_temp.iucn_code(iucn_status) IS NOT NULL THEN 'wikidata' END)
WHERE iucn_status IS NOT NULL;

-- Other Taxa statuses (iNaturalist, at add time) move into species_traits. These species had no
-- traits row; source_attribution is required, so it names iNaturalist.
INSERT INTO species_traits (species_id, iucn_status, iucn_source, source_attribution)
SELECT s.id, pg_temp.iucn_code(s.iucn_status), 'inaturalist', 'iNaturalist'
FROM species s
WHERE s.iucn_status IS NOT NULL AND pg_temp.iucn_code(s.iucn_status) IS NOT NULL
ON CONFLICT (species_id) DO UPDATE
  SET iucn_status = EXCLUDED.iucn_status, iucn_source = EXCLUDED.iucn_source
  WHERE species_traits.iucn_status IS NULL;

ALTER TABLE species_traits
  ADD CONSTRAINT species_traits_iucn_status_code
    CHECK (iucn_status IS NULL OR iucn_status IN ('EX', 'EW', 'CR', 'EN', 'VU', 'LR/cd', 'NT', 'LC', 'DD', 'NE')),
  ADD CONSTRAINT species_traits_iucn_source_known
    CHECK (iucn_source IS NULL OR iucn_source IN ('iucn_red_list', 'wikidata', 'inaturalist'));

ALTER TABLE species DROP COLUMN IF EXISTS iucn_status;
