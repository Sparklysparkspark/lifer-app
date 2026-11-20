-- One row per change an assistant made through the MCP server, with what undoes it, so "undo the
-- assistant's last change" always works (docs/docs/api/mcp.md). Nothing here is synced or exported.
CREATE TABLE change_batches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary    text NOT NULL,
  -- A list of undo steps, e.g. [{"op":"removeFromAlbum","albumId":"...","captureIds":["..."]}].
  undo       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at  timestamptz
);

CREATE INDEX change_batches_user_recent ON change_batches (user_id, created_at DESC);
