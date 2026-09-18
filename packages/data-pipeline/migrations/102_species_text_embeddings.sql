-- Zero-shot CLIP text-prompt embeddings, one per species — a completely independent signal
-- from image-image matching (species_reference_embeddings/species_reference_gallery_embeddings),
-- blended into ranking in embeddings.ts. Precomputed once per species rather than per suggestion
-- request: embedding ~650 species' names live on every request would dominate latency, while a
-- species' own name never changes, so there's nothing to gain from recomputing it per-request.
-- Confirmed live (this investigation) to roughly double honest leave-one-out top-1 accuracy when
-- blended with the existing image signal — see embeddings.ts's own comments for the numbers.
CREATE TABLE species_text_embeddings (
  species_id uuid PRIMARY KEY REFERENCES species(id) ON DELETE CASCADE,
  embedding real[] NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
