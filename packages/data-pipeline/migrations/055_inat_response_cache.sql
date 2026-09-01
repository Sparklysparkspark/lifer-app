-- Same purpose and shape as gbif_response_cache (migration 040), for iNaturalist API calls —
-- apps/api/src/species/lazyEnrich.ts's own fetchWithRetry (separate from data-pipeline's, and
-- used for both iNaturalist JSON lookups AND raw image-byte downloads from other hosts) had no
-- persistent cache at all, so any script re-checking already-enriched species (e.g.
-- detect-implausible-regions.ts's extinct-in-wild/endemic-region sweep) re-fetched the exact
-- same taxon data live over the network every time, even though normal enrichment had already
-- fetched it once. Only ever populated for the iNaturalist JSON API hosts (see fetchWithRetry's
-- own host check) — never for image-byte downloads, which live on different hosts entirely and
-- would be wrong to store as text here anyway.
CREATE TABLE IF NOT EXISTS inat_response_cache (
  url text PRIMARY KEY,
  response text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
