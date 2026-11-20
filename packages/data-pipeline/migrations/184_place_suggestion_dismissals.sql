-- Suggested places the user turned down. A suggestion is known by its anchor: the 200 m grid
-- cell of its centre, so a dismissed one never comes back even as more photos arrive there.
-- Per install and not synced, like the suggestions themselves.
CREATE TABLE place_suggestion_dismissals (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cell         text NOT NULL CHECK (char_length(cell) <= 64),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cell)
);
