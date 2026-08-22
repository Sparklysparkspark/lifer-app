// Source: Natural Earth's "Marine Polys" layer (ne_10m_geography_marine_polys), same public-
// domain source (naturalearthdata.com) and same GitHub mirror already used for admin0/admin1
// boundaries — no new dataset or license to vet. 306 named marine features worldwide
// (oceans, seas, gulfs, bays, straits, etc.); scoped here to featurecla "sea"/"ocean"/"gulf"
// only (139 of the 306) — a "major named body of water" granularity ("Indian Ocean, Red
// Sea"), not down to individual straits/bays/lagoons/fjords.
import { readFileSync } from "node:fs";
import { fetchCached } from "../raw-cache.js";
import type { GeoJsonFeature } from "./fetch-region-boundary.js";
import {
  simplifyRingToMaxPoints,
  ensureCounterClockwise,
  ringToWktPolygon,
  ringBoundingBox,
  type Point,
  type BoundingBox,
} from "../geometry.js";

const MARINE_POLYS_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_marine_polys.geojson";

// Two separate GBIF limits stack here, both found by live binary search (neither documented
// anywhere findable): (1) the `geometry` WKT param itself rejects polygons above ~170 total
// coordinate entries per ring (a clean synthetic circle: 170 succeeds, 171 fails
// consistently); (2) the TOTAL request URL — geometry + every repeated `taxonKey` param
// together — fails somewhere around 3,840-3,905 characters (confirmed by holding the
// geometry fixed and varying taxonKey count, and separately holding taxonKey count fixed at
// all 52 fish keys and varying geometry complexity). Fish queries repeat up to 52 taxonKeys
// (~710 characters — GBIF has no single class-rank key for ray-finned fish, see
// fetch-fish-orders.ts), which leaves far less budget for the geometry than constraint (1)
// alone would suggest. 80 points keeps the Red Sea's real (not just simplified-to-a-blob)
// shape at ~2,500 total URL characters even with all 52 fish keys attached — comfortable
// margin below the ~3,840 wall.
const MAX_WKT_POINTS = 80;

export interface MarineZone {
  name: string;
  wkt: string;
  bbox: BoundingBox;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

const INCLUDED_FEATURECLA = new Set(["sea", "ocean", "gulf"]);

// Circumpolar oceans wrap around a pole and/or cross the antimeridian (±180° longitude) —
// these 400 against GBIF even after simplification/convex-hull fallback, since a simple
// lon/lat polygon ring can't represent "everything above 66°N" or a shape
// that crosses the dateline at all. A real fix needs antimeridian-splitting logic (multiple
// polygons unioned) that's out of scope for two zones — excluded here rather than crashing
// per-region computation whenever a country happens to border one.
const EXCLUDED_ZONES = new Set(["Arctic Ocean", "SOUTHERN OCEAN"]);

export async function fetchMarineZones(): Promise<MarineZone[]> {
  const path = await fetchCached("natural-earth", "ne_10m_geography_marine_polys.geojson", MARINE_POLYS_URL);
  const data = JSON.parse(readFileSync(path, "utf-8")) as GeoJsonFeatureCollection;

  const zones: MarineZone[] = [];
  for (const feature of data.features) {
    const name = feature.properties.name as string | undefined;
    const featurecla = feature.properties.featurecla as string | undefined;
    if (!name || !featurecla || !INCLUDED_FEATURECLA.has(featurecla) || EXCLUDED_ZONES.has(name)) continue;

    const geometry = feature.geometry as { type: string; coordinates: unknown };
    // Only the exterior ring of the largest polygon is used — holes (e.g. islands inside a
    // sea) don't matter for "is a species found in this body of water," and a MultiPolygon's
    // smaller parts (usually disconnected slivers along a coastline) add little coverage for
    // a lot of extra WKT complexity, so only the largest ring by point count is kept.
    let exteriorRings: Point[][];
    if (geometry.type === "Polygon") {
      exteriorRings = [(geometry.coordinates as Point[][])[0]];
    } else if (geometry.type === "MultiPolygon") {
      exteriorRings = (geometry.coordinates as Point[][][]).map((poly) => poly[0]);
    } else {
      continue;
    }
    const largest = exteriorRings.reduce((a, b) => (b.length > a.length ? b : a));
    const simplified = ensureCounterClockwise(simplifyRingToMaxPoints(largest, MAX_WKT_POINTS));
    zones.push({ name, wkt: ringToWktPolygon(simplified), bbox: ringBoundingBox(largest) });
  }

  console.log(`[marine-zones] parsed ${zones.length} named sea/ocean/gulf zones`);
  return zones;
}

async function main() {
  const zones = await fetchMarineZones();
  console.log(zones.slice(0, 5).map((z) => ({ name: z.name, wktLength: z.wkt.length, bbox: z.bbox })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
