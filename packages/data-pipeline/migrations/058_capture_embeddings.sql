-- Species auto-suggest (local-first, on by default — see lifer-spec-adjacent plan doc). Plain
-- real[] vectors, not a vector-typed column: the desktop app's embedded Postgres ships no
-- extensions (no pgvector), so nearest-neighbor ranking happens in application code instead.
--
-- One row per confirmed capture — recomputed if the model version changes (model_version lets
-- the backfill job tell a stale vector apart from a current one instead of guessing from
-- computed_at).
CREATE TABLE capture_embeddings (
  capture_id uuid PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Centrally computed against each species' reference photo(s), shipped as part of the existing
-- catalog seed download rather than a new download mechanism. Keyed on species_id like every
-- other per-species table (species_reference_photos, species_traits, species_rarity), not on
-- gbif_key — gbif_key is only the external cross-reference anchor.
CREATE TABLE species_reference_embeddings (
  species_id uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
