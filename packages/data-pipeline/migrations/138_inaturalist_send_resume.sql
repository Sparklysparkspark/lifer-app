-- A capture's link to its iNaturalist observation is written as soon as the observation exists,
-- before its photo is uploaded, so a send that fails partway resumes on the same observation
-- instead of creating a second one. photo_sent stays false until that capture's photo is uploaded.
ALTER TABLE capture_inaturalist_observations ADD COLUMN photo_sent boolean NOT NULL DEFAULT true;
