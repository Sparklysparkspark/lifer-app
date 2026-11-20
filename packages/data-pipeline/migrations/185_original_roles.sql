-- Photo versions (edits and exports of one photographed moment). Every file keeps its own
-- capture; a version's capture is hidden behind its group's capture, so it counts once
-- everywhere and a split brings it back exactly as it was.

-- What the file is within its moment. NULL until the version pass has read the file.
ALTER TABLE originals ADD COLUMN role text CHECK (role IN ('original', 'edit', 'export'));
-- The XMP document the file descends from (OriginalDocumentID, else DerivedFromDocumentID,
-- else its own DocumentID), normalised. Files sharing one are versions of one photo.
ALTER TABLE originals ADD COLUMN document_id text CHECK (char_length(document_id) <= 200);

CREATE INDEX idx_originals_document_id ON originals (user_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_originals_role_pending ON originals (id)
  WHERE role IS NULL AND capture_id IS NOT NULL AND kind IN ('jpeg', 'raw');

-- One row per grouping decision about a capture: linked behind group_capture_id, suggested for a
-- person to confirm, or dismissed (split or turned down, so the rules never link it again).
CREATE TABLE capture_versions (
  capture_id       uuid PRIMARY KEY REFERENCES captures_all(id) ON DELETE CASCADE,
  group_capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence         text NOT NULL CHECK (evidence IN ('document_id', 'time_serial_suffix', 'suggested', 'manual')),
  state            text NOT NULL CHECK (state IN ('linked', 'suggested', 'dismissed')),
  -- The link hid the capture, so a split unhides it; one the user had hidden stays hidden.
  hid_capture      boolean NOT NULL DEFAULT false,
  -- This version's photo is shown on the group's capture (the photo rows are swapped).
  displayed        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  CHECK (capture_id <> group_capture_id)
);

CREATE INDEX idx_capture_versions_group ON capture_versions (group_capture_id) WHERE state = 'linked';
CREATE INDEX idx_capture_versions_suggested ON capture_versions (user_id) WHERE state = 'suggested';
