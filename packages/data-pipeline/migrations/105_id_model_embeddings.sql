-- Vectors for the species identification model (BioCLIP 2), kept apart from the CLIP tables
-- (capture_embeddings, species_reference_embeddings, species_reference_gallery_embeddings,
-- species_text_embeddings). The two models do different jobs: BioCLIP 2 names species far more
-- accurately (a real-library benchmark: 51/55 top-1 vs 39/55), while CLIP stays much better at
-- everything else those vectors are used for (Gallery search, near-duplicates, burst grouping),
-- so an install keeps both and each table only ever holds one model's vectors.
--
-- Same shapes and keys as their CLIP counterparts, so the same asset formats and merge code apply.

-- One per confirmed capture, computed from the subject-cropped photo (unlike capture_embeddings,
-- which stays uncropped for near-duplicate detection), for the "you've photographed this before"
-- signal in suggestions.
CREATE TABLE id_model_capture_embeddings (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Each species' main reference photo.
CREATE TABLE id_model_reference_embeddings (
  species_id uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- One per gallery photo.
CREATE TABLE id_model_gallery_embeddings (
  reference_photo_id uuid PRIMARY KEY REFERENCES species_reference_photos(id) ON DELETE CASCADE,
  species_id uuid NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX id_model_gallery_embeddings_species_idx ON id_model_gallery_embeddings (species_id);

-- Zero-shot text vector per species ("a photo of <scientific name>."). Computed centrally only:
-- installs never ship this model's text encoder.
CREATE TABLE id_model_text_embeddings (
  species_id uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
