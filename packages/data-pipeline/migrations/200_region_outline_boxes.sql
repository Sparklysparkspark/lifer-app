-- Each outline's exterior-ring boxes, [[minLon, minLat, maxLon, maxLat], ...], kept with the
-- outline so finding the region at a point (apps/api/src/regions/regionAt.ts) reads small boxes
-- instead of parsing every outline, which took about 20 seconds on a full catalog.
ALTER TABLE regions ADD COLUMN outline_boxes jsonb;

-- Same rings as exteriorRingsFromGeometry: a Feature's geometry or the geometry itself.
CREATE FUNCTION region_outline_boxes(b jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  RETURN (
    WITH g AS (SELECT COALESCE(b->'geometry', b) AS geom),
    rings AS (
      SELECT geom->'coordinates'->0 AS ring FROM g WHERE geom->>'type' = 'Polygon'
      UNION ALL
      SELECT poly->0 FROM g, jsonb_array_elements(geom->'coordinates') poly WHERE geom->>'type' = 'MultiPolygon'
    )
    SELECT jsonb_agg(box) FROM rings, LATERAL (
      SELECT jsonb_build_array(min((p->>0)::float8), min((p->>1)::float8), max((p->>0)::float8), max((p->>1)::float8)) AS box
      FROM jsonb_array_elements(ring) p
    ) x
    WHERE jsonb_typeof(ring) = 'array' AND jsonb_array_length(ring) > 0
  );
-- A malformed outline gets no boxes rather than failing a catalog load.
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION regions_set_outline_boxes() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  NEW.outline_boxes := region_outline_boxes(NEW.boundary_geojson);
  RETURN NEW;
END;
$$;

CREATE TRIGGER regions_outline_boxes
  BEFORE INSERT OR UPDATE OF boundary_geojson ON regions
  FOR EACH ROW EXECUTE FUNCTION regions_set_outline_boxes();

UPDATE regions SET outline_boxes = region_outline_boxes(boundary_geojson) WHERE boundary_geojson IS NOT NULL;

-- A saved spot's photo count and nearby photos: a latitude band and its name, not a full scan.
CREATE INDEX captures_all_user_lat_idx ON captures_all (user_id, lat);
CREATE INDEX captures_all_user_label_idx ON captures_all (user_id, lower(location_label));
