-- Lists added from iNaturalist ("spiders of Canada"): a saved taxon + place that a background job
-- fills page by page (apps/api/src/species/speciesLists). Per user, like checklist additions. The
-- species stay personal: new ones are is_other_taxa rows, and a list puts them on a checklist only
-- through region_species_user_added, never region_species, so packs, the catalog seed and the
-- publish gate never see them.
CREATE TABLE species_lists (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 500),
  inat_taxon_id     integer NOT NULL CHECK (inat_taxon_id > 0),
  taxon_name        text NOT NULL CHECK (length(taxon_name) <= 500),
  taxon_rank        text CHECK (length(taxon_rank) <= 50),
  inat_place_id     integer NOT NULL CHECK (inat_place_id > 0),
  place_name        text NOT NULL CHECK (length(place_name) <= 500),
  -- The Lifer region whose checklist the species are added to.
  region_id         uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  native_only       boolean NOT NULL DEFAULT false,
  -- iNaturalist's total for the query at the last page read.
  size_estimate     integer,
  added_count       integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'paused', 'offline', 'done', 'failed')),
  -- A code, never text for people: offline, rate_limited, refused, failed.
  last_error        text,
  -- Resume point: the next species_counts page to read.
  next_page         integer NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  -- Batches past the size cap, and retries after a failure, wait until this time.
  next_batch_at     timestamptz,
  hidden            boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz,
  -- Sync bookkeeping, as saved_spots (migration 168).
  pushed_at         timestamptz,
  remote_updated_at timestamptz,
  UNIQUE (user_id, inat_taxon_id, inat_place_id, region_id)
);
CREATE INDEX species_lists_user_updated_idx ON species_lists (user_id, updated_at, id);
CREATE INDEX species_lists_work_idx ON species_lists (created_at) WHERE status IN ('queued', 'running', 'offline');

CREATE TABLE species_list_members (
  list_id             uuid NOT NULL REFERENCES species_lists(id) ON DELETE CASCADE,
  species_id          uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  inat_taxon_id       integer NOT NULL,
  -- Research Grade observations in the place, and iNaturalist's establishment means there.
  inat_count          integer,
  establishment_means text,
  -- This list created the species row, so removing the list may drop it once nothing else uses it.
  created_species     boolean NOT NULL DEFAULT false,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, species_id)
);
CREATE INDEX species_list_members_species_idx ON species_list_members (species_id);

CREATE TRIGGER species_lists_updated_at BEFORE UPDATE ON species_lists
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();
CREATE TRIGGER species_list_members_updated_at BEFORE UPDATE ON species_list_members
  FOR EACH ROW EXECUTE FUNCTION sync_touch_updated_at();

-- The Collection reads both (list groups), so a change bumps its ETag (migrations 111 and 121).
CREATE TRIGGER species_lists_collection_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON species_lists
  FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version();
CREATE TRIGGER species_list_members_collection_version
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON species_list_members
  FOR EACH STATEMENT EXECUTE FUNCTION bump_collection_data_version();

ALTER TABLE sync_tombstones DROP CONSTRAINT sync_tombstones_kind_check;
ALTER TABLE sync_tombstones ADD CONSTRAINT sync_tombstones_kind_check CHECK (kind IN
  ('capture', 'user_species', 'album', 'trip', 'album_capture', 'album_exclusion', 'species_split_kept',
   'saved_spot', 'species_list'));

-- Members leave with their list, whose tombstone covers them.
CREATE FUNCTION species_lists_tombstone() RETURNS trigger AS $$
BEGIN
  IF current_setting('lifer.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO sync_tombstones (user_id, kind, ref, base)
    SELECT user_id, 'species_list', id::text, remote_updated_at FROM gone;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER species_lists_tombstone AFTER DELETE ON species_lists
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION species_lists_tombstone();

-- A list's checklist additions, apart from hand ones: a hand addition (false) wins, and removing a
-- list takes off only rows it put there.
ALTER TABLE region_species_user_added ADD COLUMN via_list boolean NOT NULL DEFAULT false;

-- Lists match existing species by iNaturalist id before creating any.
CREATE INDEX IF NOT EXISTS species_inat_taxon_id_idx ON species (inat_taxon_id) WHERE inat_taxon_id IS NOT NULL;
