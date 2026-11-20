-- A trip started ahead of time: its dates (end open until set), an optional region for import
-- suggestions, and the user's own active/inactive choice (NULL means go by the dates).
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS start_date date NULL,
  ADD COLUMN IF NOT EXISTS end_date date NULL,
  ADD COLUMN IF NOT EXISTS region_id uuid NULL REFERENCES regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS active_override boolean NULL;
ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_dates_order;
ALTER TABLE trips ADD CONSTRAINT trips_dates_order CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);

-- Photos the user said don't belong to a trip whose dates they fall in: never suggested again.
CREATE TABLE IF NOT EXISTS trip_suggestion_dismissals (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, capture_id)
);
