-- Observations the user made on iNaturalist themselves (not through Lifer) can be linked to the
-- photos they came from, so those photos stop showing in To send.
-- source: NULL for an observation Lifer sent, 'inaturalist' for one found there and linked.
ALTER TABLE capture_inaturalist_observations ADD COLUMN source text CHECK (source IN ('inaturalist'));

-- When the user's own observations were last read from iNaturalist; the next read asks only for
-- what changed since. Reset on a new sign-in.
ALTER TABLE user_inaturalist_accounts ADD COLUMN observations_synced_at timestamptz;

-- The parsed observations (taxon, time, point, accuracy, geoprivacy, place text, photo sizes, as
-- inaturalist/matching.ts RemoteObservation), cached per install. Removed with the account on disconnect.
CREATE TABLE inaturalist_remote_observations (
  user_id              uuid NOT NULL REFERENCES user_inaturalist_accounts(user_id) ON DELETE CASCADE,
  inat_observation_id  bigint NOT NULL,
  data                 jsonb NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (user_id, inat_observation_id)
);

-- A suggested match the user said isn't one, so it's never suggested again.
CREATE TABLE capture_inaturalist_not_matches (
  capture_id           uuid NOT NULL REFERENCES captures_all(id) ON DELETE CASCADE,
  inat_observation_id  text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, inat_observation_id)
);

-- CLIP vectors of each observation photo's small preview (whole photo and subject crop), so a
-- preview is downloaded and read once. The preview itself isn't kept.
CREATE TABLE inaturalist_photo_embeddings (
  user_id         uuid NOT NULL REFERENCES user_inaturalist_accounts(user_id) ON DELETE CASCADE,
  inat_photo_id   bigint NOT NULL,
  embedding       real[] NOT NULL,
  crop_embedding  real[] NOT NULL,
  model_version   text NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, inat_photo_id)
);
