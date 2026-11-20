-- A share link shows where its photos were taken (place names; sensitive species only by province
-- or country) only when its owner turns this on. Off for every existing link.
ALTER TABLE shared_links ADD COLUMN IF NOT EXISTS show_exact_locations boolean NOT NULL DEFAULT false;
