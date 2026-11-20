// Region packs for the realistic fixture (one per country and taxon, provinces bundled), the
// reference pictures in them, and a blank basemap. Built once and kept in a cache folder keyed by
// the fixture's source, so later runs only re-serve the files.
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as tar from "tar";
import { REAL_COUNTRIES, REAL_SPECIES, REALISTIC_TAXA, type RealSpecies } from "./realisticCatalog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Changes whenever the fixture's code does, so a stale cache is never reused. */
export const FIXTURE_KEY = createHash("sha256")
  .update(
    ["realisticCatalog.ts", "realisticPacks.ts", "realisticLibrary.ts"]
      .map((f) => readFileSync(path.join(HERE, f)))
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 12);
export const CACHE_DIR = path.join(REPO_ROOT, "node_modules", ".cache", "lifer-e2e", `realistic-${FIXTURE_KEY}`);

export interface RealisticPack {
  id: string;
  file: string;
  region: string;
  taxon: string;
  speciesCount: number;
  scientificNames: string[];
  contentVersion: string;
}

/** A picture no other species has: its own hue, and its index as a row of bars. */
export function speciesPixels(index: number, width: number, height: number, hueShift = 0): Buffer {
  const hue = ((index * 137.508 + hueShift) % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.55, 0.5);
  const pixels = Buffer.alloc(width * height * 3);
  const bars = 12;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const bar = Math.floor((x / width) * bars);
      const inBarBand = y > height * 0.7 && y < height * 0.85;
      const on = inBarBand && ((index >> (bars - 1 - bar)) & 1) === 1;
      const shade = 0.75 + (0.25 * y) / height;
      pixels[i] = on ? 245 : r * shade;
      pixels[i + 1] = on ? 245 : g * shade;
      pixels[i + 2] = on ? 245 : b * shade;
    }
  }
  return pixels;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

async function writeSpeciesPhotos(dir: string, species: RealSpecies[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const withPhoto = species.filter((s) => s.hasPhoto);
  // In batches, so only a few raw pixel buffers are alive at once.
  for (let start = 0; start < withPhoto.length; start += 32) {
    await Promise.all(
      withPhoto.slice(start, start + 32).map(async (s) => {
        const raw = sharp(speciesPixels(s.index, 480, 360), { raw: { width: 480, height: 360, channels: 3 } });
        await raw
          .clone()
          .webp({ quality: 70 })
          .toFile(path.join(dir, `${s.index}-display.webp`));
        await raw
          .clone()
          .resize(160)
          .webp({ quality: 70 })
          .toFile(path.join(dir, `${s.index}-thumb.webp`));
      }),
    );
  }
}

/** A valid PMTiles v3 archive with no tiles: the map draws its background and the region outline only. */
function blankPmtiles(): Buffer {
  const rootDir = Buffer.from([0]);
  const metadata = Buffer.from(JSON.stringify({ vector_layers: [] }));
  const header = Buffer.alloc(127);
  header.write("PMTiles", 0, "ascii");
  header.writeUInt8(3, 7);
  const u64 = (offset: number, value: number) => header.writeBigUInt64LE(BigInt(value), offset);
  u64(8, 127);
  u64(16, rootDir.length);
  u64(24, 127 + rootDir.length);
  u64(32, metadata.length);
  u64(40, 127 + rootDir.length + metadata.length);
  u64(48, 0);
  u64(56, 127 + rootDir.length + metadata.length);
  u64(64, 0);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internal compression: none
  header.writeUInt8(1, 98); // tile compression: none
  header.writeUInt8(1, 99); // vector tiles
  header.writeUInt8(0, 100);
  header.writeUInt8(8, 101);
  header.writeInt32LE(-180e7, 102);
  header.writeInt32LE(-85e7, 106);
  header.writeInt32LE(180e7, 110);
  header.writeInt32LE(85e7, 114);
  return Buffer.concat([header, rootDir, metadata]);
}

export const BASEMAP_FILE = path.join(CACHE_DIR, "world.pmtiles");

export async function buildRealisticPacks(log: (line: string) => void): Promise<RealisticPack[]> {
  const indexFile = path.join(CACHE_DIR, "packs.json");
  if (existsSync(indexFile)) {
    log(`reusing the realistic fixture cache in ${CACHE_DIR}`);
    return JSON.parse(readFileSync(indexFile, "utf8")) as RealisticPack[];
  }
  const started = Date.now();
  rmSync(CACHE_DIR, { recursive: true, force: true });
  const photoDir = path.join(CACHE_DIR, "species-photos");
  await writeSpeciesPhotos(photoDir, REAL_SPECIES);
  writeFileSync(BASEMAP_FILE, blankPmtiles());

  const packs: RealisticPack[] = [];
  for (const country of REAL_COUNTRIES) {
    for (const taxon of REALISTIC_TAXA) {
      const id = `${country.name.toLowerCase().replace(/\s+/g, "-")}-${taxon}`;
      const work = path.join(CACHE_DIR, "work", id);
      mkdirSync(path.join(work, "photos"), { recursive: true });
      const inTaxon = (i: number) => REAL_SPECIES[i].taxonClass === taxon;
      const entry = (i: number) => {
        const s = REAL_SPECIES[i];
        if (s.hasPhoto) {
          for (const kind of ["display", "thumb"]) {
            linkSync(path.join(photoDir, `${i}-${kind}.webp`), path.join(work, "photos", `${i}-${kind}.webp`));
          }
        }
        return {
          scientificName: s.scientificName,
          habitatDescription: null,
          referenceCredit: s.hasPhoto ? "Lifer e2e fixture" : null,
          referenceLicense: s.hasPhoto ? "CC0" : null,
          displayFile: s.hasPhoto ? `photos/${i}-display.webp` : null,
          thumbFile: s.hasPhoto ? `photos/${i}-thumb.webp` : null,
          localTier: country.tiers.get(i) ?? "common",
        };
      };
      const members = country.members.filter(inTaxon);
      const entries = members.map(entry);
      const byName = new Map(entries.map((e, k) => [members[k], e]));
      const manifest = {
        type: "region",
        region: country.name,
        taxon,
        species: entries,
        children: country.provinces.map((p) => ({
          name: p.name,
          ebirdRegionCode: p.ebird,
          boundaryGeoJson: p.boundary,
          externalCodes: p.codes,
          isOverseasTerritory: false,
          species: p.members.filter(inTaxon).map((i) => byName.get(i)!),
        })),
      };
      const manifestJson = JSON.stringify(manifest);
      writeFileSync(path.join(work, "manifest.json"), manifestJson);
      const file = path.join(CACHE_DIR, `${id}.pack.tar.gz`);
      await tar.c({ gzip: true, file, cwd: work, portable: true }, ["manifest.json", "photos"]);
      packs.push({
        id,
        file,
        region: country.name,
        taxon,
        speciesCount: entries.length,
        scientificNames: entries.map((e) => e.scientificName),
        contentVersion: createHash("sha256").update(manifestJson).digest("hex").slice(0, 16),
      });
    }
  }
  rmSync(path.join(CACHE_DIR, "work"), { recursive: true, force: true });
  writeFileSync(indexFile, JSON.stringify(packs));
  log(`built the realistic fixture's packs in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return packs;
}
