// Source: Marine Ecoregions of the World (MEOW): Spalding MD, Fox HE, Allen GR, Davidson N,
// Ferdaña ZA, Finlayson M, Halpern BS, Jorge MA, Lombana A, Lourie SA, Martin KD, McManus E,
// Molnar J, Recchia CA, Robertson J (2007) "Marine Ecoregions of the World: a
// bioregionalization of coast and shelf areas." BioScience 57: 573-583. Shapefile hosted by
// The Nature Conservancy (a stable, public, no-auth ArcGIS content item).
// License (from the item's metadata): public use for non-commercial purposes without altering
// the data. It must never be redistributed or altered if this project is open-sourced.
//
// Replaces fetch-marine-zones.ts's Natural Earth ocean basins, which were far too coarse as a
// "nearby water" proxy. MEOW's ~232 coastal ecoregions let a region border a specific named
// ecoregion rather than a whole ocean.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as shapefile from "shapefile";
import { fetchCached, RAW_DIR } from "../raw-cache.js";
import type { GeoJsonFeature } from "./fetch-region-boundary.js";
import {
  simplifyRingToMaxPoints,
  ensureCounterClockwise,
  ringToWktPolygon,
  ringBoundingBox,
  type Point,
  type BoundingBox,
} from "../geometry.js";

const MEOW_ZIP_URL = "https://www.arcgis.com/sharing/rest/content/items/903c3ae05b264c00a3b5e58a4561b7e6/data";
const SHP_NAME = "meow_ecos.shp";
const DBF_NAME = "meow_ecos.dbf";

// Same GBIF WKT and URL-length limits as fetch-marine-zones.ts.
const MAX_WKT_POINTS = 80;

export interface MarineZone {
  name: string;
  wkt: string;
  bbox: BoundingBox;
}

function extractShapefile(zipPath: string): { shp: string; dbf: string } {
  const extractDir = path.join(RAW_DIR, "meow", "extracted");
  const shp = path.join(extractDir, SHP_NAME);
  const dbf = path.join(extractDir, DBF_NAME);
  if (!existsSync(shp) || !existsSync(dbf)) {
    mkdirSync(extractDir, { recursive: true });
    execFileSync("unzip", ["-o", zipPath, SHP_NAME, DBF_NAME, "-d", extractDir]);
  }
  return { shp, dbf };
}

export async function fetchMarineEcoregions(): Promise<MarineZone[]> {
  const zipPath = await fetchCached("meow", "MEOW-TNC.zip", MEOW_ZIP_URL);
  const { shp, dbf } = extractShapefile(zipPath);
  const collection = (await shapefile.read(shp, dbf)) as { features: GeoJsonFeature[] };

  const zones: MarineZone[] = [];
  for (const feature of collection.features) {
    const name = feature.properties.ECOREGION as string | undefined;
    if (!name) continue;

    // Largest exterior ring only, as for the ocean-basin zones.
    const geometry = feature.geometry as { type: string; coordinates: unknown };
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

  console.log(`[marine-ecoregions] parsed ${zones.length} MEOW ecoregions`);
  return zones;
}

async function main() {
  const zones = await fetchMarineEcoregions();
  console.log(zones.slice(0, 5).map((z) => ({ name: z.name, wktLength: z.wkt.length, bbox: z.bbox })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
