// Source: Natural Earth's "Marine Polys" layer (ne_10m_geography_marine_polys), the same
// public-domain source and mirror as the admin0/admin1 boundaries. Scoped to featurecla
// "sea"/"ocean"/"gulf": major named bodies of water, not individual straits, bays or fjords.
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

// Two undocumented GBIF limits stack here, both found empirically: (1) the `geometry` WKT param
// rejects rings above ~170 coordinates; (2) the whole request URL fails around 3,840
// characters. Fish queries repeat up to 52 taxonKeys (~710 characters, see
// fetch-fish-orders.ts), leaving much less room for geometry. 80 points keeps a realistic shape
// at ~2,500 URL characters with all fish keys attached.
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

// Circumpolar oceans wrap a pole or cross the antimeridian, which a simple lon/lat ring can't
// represent, so GBIF rejects them. Excluded rather than adding antimeridian splitting for two zones.
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
    // Only the exterior ring of the largest polygon: holes and small disconnected parts add little
    // coverage for a lot of extra WKT.
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
