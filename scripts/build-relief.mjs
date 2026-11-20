#!/usr/bin/env node
// Builds the offline relief archive (terrarium elevation tiles in a PMTiles file) in one resumable
// command: node scripts/build-relief.mjs [--max-zoom 6] [--out ~/lifer-relief-work] [--concurrency 8]
// Tiles are fetched once into <out>/tiles and skipped on re-run; the archive is rebuilt from them.
// Source: the open Terrain Tiles composite on AWS (SRTM, GMTED2010, ETOPO1 and others, see credits).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "max-zoom": { type: "string", default: "6" },
    out: { type: "string", default: join(homedir(), "lifer-relief-work") },
    concurrency: { type: "string", default: "8" },
  },
});
const maxZoom = Number(values["max-zoom"]);
const tilesDir = join(values.out, "tiles");
const BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

const jobs = [];
for (let z = 0; z <= maxZoom; z++)
  for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) jobs.push([z, x, y]);

async function fetchTile([z, x, y]) {
  const file = join(tilesDir, `${z}/${x}/${y}.png`);
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}/${z}/${x}/${y}.png`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Written under a temp name so an interrupted run never leaves a half tile behind.
      writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
      renameSync(`${file}.part`, file);
      return;
    } catch (err) {
      if (attempt === 5) throw new Error(`tile ${z}/${x}/${y}: ${err.message}`, { cause: err });
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < jobs.length) {
      await fetchTile(jobs[next++]);
      if (++done % 500 === 0) console.log(`${done}/${jobs.length} tiles`);
    }
  }),
);

const mbtiles = join(values.out, `relief-z${maxZoom}.mbtiles`);
const pmtiles = join(values.out, `relief-z${maxZoom}.pmtiles`);
rmSync(mbtiles, { force: true });
const db = new DatabaseSync(mbtiles);
db.exec(`CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);`);
const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
for (const [k, v] of Object.entries({ name: "relief", format: "png", minzoom: "0", maxzoom: String(maxZoom) }))
  meta.run(k, v);
const insert = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
db.exec("BEGIN");
for (const [z, x, y] of jobs) insert.run(z, x, 2 ** z - 1 - y, readFileSync(join(tilesDir, `${z}/${x}/${y}.png`)));
db.exec("COMMIT");
db.close();
rmSync(pmtiles, { force: true });
execFileSync("pmtiles", ["convert", mbtiles, pmtiles], { stdio: "inherit" });
rmSync(mbtiles);
console.log(`${pmtiles}: ${(statSync(pmtiles).size / 1e6).toFixed(1)} MB, ${jobs.length} tiles`);
