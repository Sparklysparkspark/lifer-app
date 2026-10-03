-- English Wikipedia pageviews over the last 12 months, a measure of public interest in a species.
-- Not a tier input on its own (how exciting a species is doesn't make it rarer): it corrects for
-- photo bias. Mammals, reptiles, amphibians and fish are rated on how often they're photographed,
-- and a species few people care about is photographed far less often than it's found, so a
-- Legendary rated from photos with little interest behind it is capped at Epic.
ALTER TABLE species_traits
  ADD COLUMN wiki_pageviews_12mo integer,
  ADD COLUMN wiki_pageviews_at timestamptz;
