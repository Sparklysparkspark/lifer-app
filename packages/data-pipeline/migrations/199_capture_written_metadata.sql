-- The exact value Lifer last wrote into each file's templated fields (title, headline, caption:
-- text; keywords: the extra keywords Lifer added, a JSON array). A file whose value still equals
-- this is Lifer's to update; one that differs was edited elsewhere and is kept. Per original and
-- per file it writes (`slot`: the file itself, its "IMG.xmp" sidecar or its "IMG.CR3.xmp" one),
-- since each is edited, and written, independently.
CREATE TABLE capture_written_metadata (
  original_id uuid NOT NULL REFERENCES originals(id) ON DELETE CASCADE,
  slot        text NOT NULL CHECK (slot IN ('file', 'stem', 'full')),
  field       text NOT NULL CHECK (field IN ('title', 'headline', 'caption', 'keywords')),
  value       jsonb NOT NULL,
  written_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (original_id, slot, field)
);
