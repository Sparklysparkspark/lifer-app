// Source: Marine Ecoregions of the World (MEOW) — Spalding MD, Fox HE, Allen GR, Davidson N,
// Ferdaña ZA, Finlayson M, Halpern BS, Jorge MA, Lombana A, Lourie SA, Martin KD, McManus E,
// Molnar J, Recchia CA, Robertson J (2007) "Marine Ecoregions of the World: a
// bioregionalization of coast and shelf areas." BioScience 57: 573-583. Shapefile hosted by
// The Nature Conservancy (a stable, public, no-auth ArcGIS content item).
// License (from the item's own metadata): public use for NON-COMMERCIAL purposes without
// altering the data — fine for this personal, non-commercial project (same basis already
// used for the eBird/iNaturalist API calls elsewhere), but this data must never be
// redistributed or altered if this project is ever open-sourced.
//
// Replaces fetch-marine-zones.ts's Natural Earth ocean-basin polygons, which were too coarse
// to be useful: "North Pacific Ocean" alone spanned the ENTIRE basin, Japan to Mexico, with
// 4,498 fish species in its checklist — utterly useless as a "nearby water" proxy for a
// single coastal region like British Columbia. MEOW's ~232 much smaller,
// scientifically-defined coastal ecoregions are the real fix — a region borders a specific
// named ecoregion (e.g. "Puget Trough/Georgia Basin" for BC), not an entire ocean.
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

// Same GBIF WKT/URL-length constraints already found and documented in fetch-marine-zones.ts.
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

    // Same "largest exterior ring only" simplification already used for the ocean-basin
    // zones — islands/holes and small disconnected slivers don't matter for "is a species
    // found in this ecoregion."
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
