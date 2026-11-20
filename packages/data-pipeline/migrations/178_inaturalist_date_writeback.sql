-- A photo with no date of its own takes the date the user added on iNaturalist when its
-- observation is finished there; this marks the link rows whose photo got it, for the Completed tab.
ALTER TABLE capture_inaturalist_observations ADD COLUMN date_from_inaturalist boolean NOT NULL DEFAULT false;
