// Detailed offline maps: one Protomaps PMTiles extract per country, cut from a Protomaps planet
// build with the go-pmtiles CLI (`pmtiles extract`, which reads only the byte ranges it needs, so
// a remote planet URL works without downloading the planet). Published to their own release with
// an index listing each file's size and sha256, like the packs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { GITHUB_REPO } from "../build/release-groups.js";

export const MAP_RELEASE_TAG = "map-detail-latest";
export const MAP_INDEX_NAME = "map-detail-index.json";
export const MAP_FILE_PREFIX = "detail-";
// The bundled world map stops at zoom 8, so extracts start where it ends. 15 is the planet's max.
export const EXTRACT_MIN_ZOOM = 9;
export const EXTRACT_MAX_ZOOM = 15;
// GitHub refuses release assets over 2 GiB.
export const MAX_ASSET_BYTES = 2 * 1024 ** 3;

export interface MapExtract {
  /** The country's ISO code (regions.external_codes[1]). */
  code: string;
  name: string;
  /** Asset name, relative to the index URL. Named by content, so a publish never replaces a file in use. */
  file: string;
  sizeBytes: number;
  sha256: string;
  /** Source, zooms and boundary hashed: an unchanged hash means the extract needs no new cut. */
  inputHash: string;
}

export interface MapIndex {
  generatedAt: string;
  source: string;
  minzoom: number;
  maxzoom: number;
  extracts: MapExtract[];
}

export interface MapCountry {
  code: string;
  name: string;
  /** GeoJSON Polygon or MultiPolygon (regions.boundary_geojson). */
  boundary: unknown;
}

export type CutFn = (
  source: string,
  regionFile: string,
  outFile: string,
  zooms: { minzoom: number; maxzoom: number },
) => void;

/** go-pmtiles on PATH (PMTILES_BIN overrides), from github.com/protomaps/go-pmtiles releases. */
export const pmtilesCut: CutFn = (source, regionFile, outFile, { minzoom, maxzoom }) => {
  execFileSync(
    process.env.PMTILES_BIN?.trim() || "pmtiles",
    ["extract", source, outFile, `--region=${regionFile}`, `--minzoom=${minzoom}`, `--maxzoom=${maxzoom}`],
    { stdio: "inherit" },
  );
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export function readMapIndex(outDir: string): MapIndex | null {
  const file = path.join(outDir, MAP_INDEX_NAME);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as MapIndex) : null;
}

/** Cuts every country whose inputs changed since the last build in `outDir`, keeping the rest.
 *  The index is written after each country, so an interrupted run resumes where it stopped.
 *  `partial` (a --countries run) keeps other countries' extracts; otherwise ones no longer listed go. */
export async function buildMapExtracts(opts: {
  countries: MapCountry[];
  source: string;
  outDir: string;
  partial?: boolean;
  cut?: CutFn;
  log?: (m: string) => void;
}): Promise<{ index: MapIndex; changed: string[]; failures: Array<{ code: string; error: string }> }> {
  const { countries, source, outDir, cut = pmtilesCut, log = console.log } = opts;
  const zooms = { minzoom: EXTRACT_MIN_ZOOM, maxzoom: EXTRACT_MAX_ZOOM };
  mkdirSync(outDir, { recursive: true });
  const previous = readMapIndex(outDir);
  const byCode = new Map((previous?.extracts ?? []).map((e) => [e.code, e]));
  const listed = new Set(countries.map((c) => c.code));
  const write = () => {
    const extracts = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    const index: MapIndex = { generatedAt: new Date().toISOString(), source, ...zooms, extracts };
    writeFileSync(path.join(outDir, MAP_INDEX_NAME), JSON.stringify(index, null, 2));
    return index;
  };
  if (!opts.partial) {
    for (const [code, e] of byCode) {
      if (listed.has(code)) continue;
      rmSync(path.join(outDir, e.file), { force: true });
      byCode.delete(code);
    }
  }

  const changed: string[] = [];
  const failures: Array<{ code: string; error: string }> = [];
  for (const country of countries) {
    if (!/^[A-Z0-9-]{2,10}$/.test(country.code)) {
      failures.push({ code: country.code, error: "not a country code" });
      continue;
    }
    const region = JSON.stringify({ type: "Feature", properties: {}, geometry: country.boundary });
    const inputHash = sha256(`${source}|${zooms.minzoom}-${zooms.maxzoom}|${region}`).slice(0, 16);
    const prev = byCode.get(country.code);
    const prevFile = prev && path.join(outDir, prev.file);
    if (prev?.inputHash === inputHash && existsSync(prevFile!) && statSync(prevFile!).size === prev.sizeBytes) {
      if (prev.name !== country.name) byCode.set(country.code, { ...prev, name: country.name });
      continue;
    }
    const regionFile = path.join(outDir, `${country.code}.region.geojson`);
    const part = path.join(outDir, `${country.code}.pmtiles.part`);
    try {
      log(`cutting ${country.name} (${country.code})`);
      writeFileSync(regionFile, region);
      rmSync(part, { force: true });
      cut(source, regionFile, part, zooms);
      const hash = await sha256File(part);
      const file = `${MAP_FILE_PREFIX}${country.code.toLowerCase()}-${hash.slice(0, 12)}.pmtiles`;
      renameSync(part, path.join(outDir, file));
      if (prev && prev.file !== file) rmSync(prevFile!, { force: true });
      const sizeBytes = statSync(path.join(outDir, file)).size;
      if (sizeBytes > MAX_ASSET_BYTES)
        log(`${country.name} is ${(sizeBytes / 1e9).toFixed(1)} GB, over the 2 GB release limit`);
      byCode.set(country.code, { code: country.code, name: country.name, file, sizeBytes, sha256: hash, inputHash });
      changed.push(country.code);
      write();
    } catch (err) {
      rmSync(part, { force: true });
      failures.push({ code: country.code, error: (err as Error).message });
      log(`${country.name} failed: ${(err as Error).message}`);
    } finally {
      rmSync(regionFile, { force: true });
    }
  }
  return { index: write(), changed, failures };
}

/** Countries (World > continent > country) with a boundary and an ISO code. */
export async function mapCountries(
  db: { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> },
  names: string[] | null,
): Promise<MapCountry[]> {
  const res = await db.query<{ code: string; name: string; boundary: unknown }>(
    `SELECT c.external_codes[1] AS code, c.name, c.boundary_geojson AS boundary FROM regions c
     JOIN regions cont ON cont.id = c.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     WHERE c.boundary_geojson IS NOT NULL AND c.external_codes[1] ~ '^[A-Z]{2,3}$'
       AND ($1::text[] IS NULL OR c.name = ANY($1))
     ORDER BY c.name`,
    [names],
  );
  return res.rows;
}

/** Uploads extracts the release lacks, then the index, then deletes extracts nothing lists. */
export function publishMapExtracts(outDir: string, log: (m: string) => void = console.log): void {
  const index = readMapIndex(outDir);
  if (!index) throw new Error(`No ${MAP_INDEX_NAME} in ${outDir}; run the maps stage first`);
  const tooBig = index.extracts.filter((e) => e.sizeBytes > MAX_ASSET_BYTES).map((e) => e.name);
  if (tooBig.length > 0)
    throw new Error(`Over GitHub's 2 GB asset limit, so nothing was published: ${tooBig.join(", ")}`);
  const gh = (args: string[], inherit = true) =>
    execFileSync("gh", [...args, "--repo", GITHUB_REPO], {
      encoding: "utf8",
      stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
  const assetNames = () =>
    JSON.parse(
      gh(["release", "view", MAP_RELEASE_TAG, "--json", "assets", "--jq", "[.assets[].name]"], false),
    ) as string[];
  try {
    gh(["release", "view", MAP_RELEASE_TAG, "--json", "tagName"], false);
  } catch {
    gh([
      "release",
      "create",
      MAP_RELEASE_TAG,
      "--title",
      "Detailed maps",
      "--notes",
      "Per-country detailed map extracts. See packages/data-pipeline/src/pipeline/maps.ts.",
      "--prerelease",
      "--latest=false",
    ]);
  }
  const used = new Set(index.extracts.map((e) => e.file));
  const onRelease = new Set(assetNames());
  for (const name of [...used].filter((n) => !onRelease.has(n))) {
    log(`uploading ${name}`);
    gh(["release", "upload", MAP_RELEASE_TAG, path.join(outDir, name), "--clobber"]);
  }
  // After the files, so an install never reads an index naming a file not uploaded yet.
  gh(["release", "upload", MAP_RELEASE_TAG, path.join(outDir, MAP_INDEX_NAME), "--clobber"]);
  for (const name of assetNames().filter((n) => n.startsWith(MAP_FILE_PREFIX) && !used.has(n))) {
    log(`deleting ${name}, no longer used`);
    gh(["release", "delete-asset", MAP_RELEASE_TAG, name, "--yes"]);
  }
}
