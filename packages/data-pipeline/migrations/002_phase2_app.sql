-- Phase 2 app tables (lifer-spec.md §6, §8, §9). Auth, uploads, collection state.
-- originals (BYOS/RAW pointers) is deliberately NOT created here — that's Phase 7 work.
-- captures/photos are split now per the spec's own §9 Phase 7 footnote: cheap to build the
-- rendition split up front, expensive to retrofit once real photos exist.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_species_common_name_trgm ON species USING gin (common_name gin_trgm_ops);
CREATE INDEX idx_species_scientific_name_trgm ON species USING gin (scientific_name gin_trgm_ops);

-- Single-use invite codes. Nothing in the spec's users table actually validates
-- invite_code_used against a real source of truth — this table is that source of truth.
CREATE TABLE invite_codes (
  code      text PRIMARY KEY,
  used_by   uuid NULL,
  used_at   timestamptz NULL
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text UNIQUE NOT NULL,
  password_hash      text NOT NULL,
  invite_code_used   text NULL REFERENCES invite_codes(code),
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invite_codes
  ADD CONSTRAINT invite_codes_used_by_fkey FOREIGN KEY (used_by) REFERENCES users(id);

-- Plain bearer token in an HTTP-only cookie, validated against this table on every request.
-- Not part of spec §6 (which doesn't model auth) but required for cookie-session auth (§4, §8).
CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);

-- A capture is one shutter press; photos (below) are its renditions over time.
CREATE TABLE captures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id        uuid NOT NULL REFERENCES species(id),
  -- Plain content hash for now, not the full EXIF-signature fingerprint from spec §8.4 —
  -- that fingerprint (DateTimeOriginal+SubSec+Model+Serial) is Phase 7 RAW-linking work.
  fingerprint       text NOT NULL,
  taken_at          timestamptz NULL,
  lat               numeric NULL,
  lon               numeric NULL,
  camera_model      text NULL,
  lens              text NULL,
  focal_length_mm   numeric NULL,
  aperture          numeric NULL,
  shutter           text NULL,
  iso               int NULL,
  quality_rating    int NULL CHECK (quality_rating BETWEEN 1 AND 5),
  current_photo_id  uuid NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_captures_user_species ON captures (user_id, species_id);

CREATE TABLE photos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id     uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  display_path   text NOT NULL,
  thumb_path     text NOT NULL,
  version_label  text NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE captures
  ADD CONSTRAINT captures_current_photo_id_fkey FOREIGN KEY (current_photo_id) REFERENCES photos(id);

CREATE TABLE user_species (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id       uuid NOT NULL REFERENCES species(id),
  state            text NOT NULL CHECK (state IN ('collected', 'seen')),
  cover_photo_id   uuid NULL REFERENCES photos(id),
  first_collected  date NULL,
  best_quality     int NULL CHECK (best_quality BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, species_id)
);
