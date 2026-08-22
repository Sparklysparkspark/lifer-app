-- Tracks which offline packs have already been applied, keyed by the pack's own stable id
-- (not species rows), so: (1) the download screen can show "already have this" instead of
-- re-fetching, and (2) a sea-zone pack shared by several countries only ever gets pulled down
-- once, however many of those countries get separately selected.
CREATE TABLE downloaded_packs (
  pack_id       text PRIMARY KEY,
  region        text NULL,
  taxon         text NULL,
  species_count integer NOT NULL DEFAULT 0,
  bytes         bigint NOT NULL DEFAULT 0,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);
