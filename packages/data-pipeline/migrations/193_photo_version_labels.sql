-- Photo versions, part two: a person's own name for a version, the folder names that hold
-- versions (Prints, B&W...), and the version-folder rule's evidence.

-- A file in a version folder next to its original, with the same name: linked when the press
-- also matches, otherwise only suggested.
ALTER TABLE capture_versions DROP CONSTRAINT capture_versions_evidence_check;
ALTER TABLE capture_versions ADD CONSTRAINT capture_versions_evidence_check
  CHECK (evidence IN ('document_id', 'time_serial_suffix', 'suggested', 'manual', 'version_folder'));

-- "Print 8x10", "For the gallery": shown in the viewer's version switcher instead of the label
-- worked out from the file name. One per capture, since every version keeps its own capture.
CREATE TABLE capture_version_labels (
  capture_id uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80)
);

-- Folder names whose files are versions of the original beside them. NULL: the default list.
ALTER TABLE users ADD COLUMN version_folder_names text[]
  CHECK (version_folder_names IS NULL OR cardinality(version_folder_names) <= 50);
