-- The user's own eBird checklists, imported from the "My eBird Data" CSV (eBird has no API for them),
-- and which photos belong to which checklist. A link starts as a suggestion (confirmed = false) and
-- the user confirms it per trip. started_at holds the checklist's local wall clock as if it were UTC,
-- the same way captures.taken_at holds the camera's, so the two compare without a time zone.
CREATE TABLE ebird_checklists (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_id        text NOT NULL,
  started_at    timestamptz NOT NULL,
  -- false when the CSV row had no time of day: started_at is midnight and the whole day matches.
  has_time      boolean NOT NULL DEFAULT true,
  duration_min  integer CHECK (duration_min IS NULL OR duration_min >= 0),
  lat           double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon           double precision CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  location      text NOT NULL DEFAULT '',
  -- Scientific names on the checklist.
  species       text[] NOT NULL DEFAULT '{}',
  imported_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sub_id)
);

CREATE INDEX ebird_checklists_user_started_idx ON ebird_checklists (user_id, started_at);

CREATE TABLE capture_ebird_checklists (
  capture_id uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  sub_id     text NOT NULL,
  confirmed  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (capture_id, sub_id),
  FOREIGN KEY (user_id, sub_id) REFERENCES ebird_checklists (user_id, sub_id) ON DELETE CASCADE
);

CREATE INDEX capture_ebird_checklists_sub_idx ON capture_ebird_checklists (user_id, sub_id);
