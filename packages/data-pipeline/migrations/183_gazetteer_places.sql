-- Offline town search and locality names (MAP-07, MAP-08, PLACE-05): GeoNames populated places
-- (CC BY 4.0). Catalog data, filled by the pipeline's gazetteer stage and shipped in the catalog
-- seed; installs without it fall back to region names. Feature class and code leave room for
-- parks, lakes and peaks from region packs later.
-- Region ids have no foreign key, like regions.home_country_id: a catalog update inserts regions
-- in any order.
CREATE TABLE gazetteer_places (
  geoname_id integer PRIMARY KEY,
  name text NOT NULL,
  ascii_name text NOT NULL,
  -- A few Latin-script other names, "|" separated ("Quebec|Kebek").
  alternate_names text NOT NULL DEFAULT '',
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  population bigint NOT NULL DEFAULT 0,
  feature_class text NOT NULL,
  feature_code text NOT NULL,
  country_code text NOT NULL,
  admin1_code text,
  country_region_id uuid,
  province_region_id uuid,
  -- Every name, folded like species search (migration 111), between "|" so a prefix of any name
  -- matches LIKE '%|prefix%'.
  search_text text GENERATED ALWAYS AS (
    '|' || lifer_search_norm(name || '|' || ascii_name || '|' || alternate_names) || '|'
  ) STORED
);

CREATE INDEX gazetteer_places_search_idx ON gazetteer_places USING gin (search_text gin_trgm_ops);
-- Nearest place: a latitude band, then longitude, then distance.
CREATE INDEX gazetteer_places_lat_lon_idx ON gazetteer_places (lat, lon);
