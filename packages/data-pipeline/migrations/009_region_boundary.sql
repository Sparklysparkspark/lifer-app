-- The filtered Natural Earth feature for this region (public domain, any use — see
-- conversation: GADM, already used for GBIF occurrence-query codes, is non-commercial-only
-- and wrong for shipping its actual polygon geometry). Consumed directly by MapLibre, no WKT
-- round-tripping needed. gbif_area_wkt (migration 001) stays unused, as it already was.
ALTER TABLE regions ADD COLUMN boundary_geojson jsonb NULL;

-- region_species.seasonality (already numeric[], migration 001) holds 12 MONTHLY values in
-- this build, not 52 weekly ones as the original spec sketch envisioned — GBIF's occurrence
-- API only facets by month, verified by hand; there's no week-of-year facet to get real
-- weekly granularity from. Documented here since the column itself doesn't say so.
