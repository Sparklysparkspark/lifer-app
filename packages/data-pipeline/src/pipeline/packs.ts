// The packs stage of the refresh pipeline (scripts/refresh.ts): builds every offline pack from the
// catalog database, keeps only the ones whose content changed against the published index, checks
// the result, and (with publish) uploads it. Packs are published in the pack store
// (pipeline/packStore.ts): a few shard files, not one release asset per pack.
//
// What "every" means:
// - One pack per region (or sea zone) and taxon, holding only the checklist. Photos are in the
//   shared photo store (pipeline/photoStore.ts) and vectors in the catalog seed, so a "small"
//   install is just one that skips gallery photos, chosen when installing, not a second pack.
// - Every taxon a country has species for, on its own list or its provinces'. A country whose own
//   list is empty while its provinces list species fails the build instead of shipping nothing.
// - Every country with species, found by id, so a country sharing a continent's name
//   (Antarctica) or one never marked computed still gets its packs.
// - Sea zone packs first, so a country pack only lists sea zone dependencies that exist.
// The merged index is refused if any dependency still doesn't resolve.
// Everything runs in this one process.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { pool } from "../db.js";
import { buildRegionPack, buildSeaZonePack } from "../build/build-region-pack.js";
import type { PackVariant } from "@lifer/core/packs/packId.js";
import { GITHUB_REPO, INDEX_RELEASE_TAG } from "../build/release-groups.js";
import { PACK_SHARD_PREFIX, publishPackStore, writePackStore } from "./packStore.js";
import type { TaxonClass } from "@lifer/shared";
import { assertPhotosPublishable } from "./photoLicensePolicy.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";

const DATA_PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VARIANTS: PackVariant[] = ["full"];
// Packs built at once. Each mostly waits on the database and on gzip (which runs off the main
// thread), so a few in parallel cut a full build's time; the pool has room for them.
const PACK_CONCURRENCY = Math.max(1, Number(process.env.PACK_CONCURRENCY ?? 6) || 6);
export const PACK_TAXA: TaxonClass[] = [
  "aves",
  "mammalia",
  "actinopterygii",
  "amphibia",
  "squamata",
  "testudines",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
] as TaxonClass[];

export interface IndexPack {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  variant?: "full" | "small";
  sizeBytes: number;
  speciesCount: number;
  contentVersion: string;
  scientificNames: string[];
  /** The pack store shard holding it, with `range` [offset, length] and the archive's `sha256`
   *  (pipeline/packStore.ts). */
  url: string;
  range?: [number, number];
  sha256?: string;
  format?: number;
  seaZoneDependencies?: string[];
}
export interface PackIndex {
  generatedAt: string;
  packs: IndexPack[];
}

// Retried, so one dropped connection doesn't fail the whole stage.
export async function fetchPublishedIndex(): Promise<PackIndex> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `https://github.com/${GITHUB_REPO}/releases/download/${INDEX_RELEASE_TAG}/pack-index.json`,
        {
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (res.status === 404) return { generatedAt: new Date(0).toISOString(), packs: [] };
      if (res.ok) return (await res.json()) as PackIndex;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(`Couldn't fetch the published pack index: ${(lastError as Error)?.message ?? lastError}`);
}

function manifestContentVersion(archivePath: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-version-"));
  try {
    tar.extract({ file: archivePath, cwd: dir, sync: true, filter: (p) => p === "manifest.json" });
    return (JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { contentVersion: string })
      .contentVersion;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Countries (World > continent > country) with any species on their own list or a province's. */
async function packCountries(names: string[] | null): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM regions c
     JOIN regions cont ON cont.id = c.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     WHERE ($1::text[] IS NULL OR c.name = ANY($1))
       AND EXISTS (SELECT 1 FROM region_species rs JOIN regions r ON r.id = rs.region_id WHERE r.id = c.id OR r.parent_id = c.id)
     ORDER BY c.name`,
    [names],
  );
  return res.rows;
}

async function taxaForCountry(countryId: string): Promise<Set<string>> {
  const res = await pool.query<{ taxon_class: string }>(
    `SELECT DISTINCT s.taxon_class FROM region_species rs JOIN regions r ON r.id = rs.region_id JOIN species s ON s.id = rs.species_id
     WHERE (r.id = $1 OR r.parent_id = $1) AND NOT s.is_other_taxa`,
    [countryId],
  );
  return new Set(res.rows.map((r) => r.taxon_class));
}

async function seaZoneTaxa(): Promise<Array<{ id: string; name: string; taxa: string[] }>> {
  const res = await pool.query<{ id: string; name: string; taxa: string[] }>(
    `SELECT z.id, z.name, array_agg(DISTINCT s.taxon_class) AS taxa
     FROM sea_zones z JOIN sea_zone_species zs ON zs.sea_zone_id = z.id JOIN species s ON s.id = zs.species_id
     WHERE NOT s.is_other_taxa GROUP BY z.id, z.name ORDER BY z.name`,
  );
  return res.rows;
}

export interface PacksResult {
  outDir: string;
  built: number;
  changed: string[];
  unchanged: number;
  failures: Array<{ pack: string; error: string }>;
  index: PackIndex | null;
}

/** Builds every pack into outDir and keeps only the changed ones. `countries` limits the country
 *  packs (sea zones are always built: country packs depend on them). */
export async function buildPacks(
  opts: { countries?: string[] | null; outDir?: string; log?: (m: string) => void } = {},
): Promise<PacksResult> {
  const log = opts.log ?? ((m) => console.log(`[packs] ${m}`));
  await assertPhotosPublishable(pool);
  const outDir = opts.outDir ?? mkdtempSync(path.join(os.tmpdir(), "lifer-packs-"));
  mkdirSync(outDir, { recursive: true });
  // A reused outDir still holds the last run's archives and shards. build-pack-index.ts indexes
  // every archive in the folder, so leftovers this run doesn't rebuild would break the store.
  for (const f of readdirSync(outDir)) {
    if (
      f.endsWith(".pack.tar.gz") ||
      (f.startsWith(PACK_SHARD_PREFIX) && f.endsWith(".bin")) ||
      f === "pack-index.json"
    )
      rmSync(path.join(outDir, f));
  }
  // Only packs already in the pack store count as published; anything else is rebuilt.
  const published = await fetchPublishedIndex();
  published.packs = published.packs.filter((p) => p.format === 3 && p.range);
  const publishedVersion = new Map(published.packs.map((p) => [p.id, p.contentVersion]));
  const result: PacksResult = { outDir, built: 0, changed: [], unchanged: 0, failures: [], index: null };
  // Files that exist after this run, published or rebuilt: what a dependency may point at.
  const available = new Set(published.packs.map((p) => `${p.id}.pack.tar.gz`));

  // Every pack this run built, changed or not: what the packs in its scope are now.
  const builtNow = new Set<string>();
  const keepIfChanged = (fileName: string) => {
    result.built++;
    builtNow.add(fileName.replace(/\.pack\.tar\.gz$/, ""));
    const archive = path.join(outDir, fileName);
    const id = fileName.replace(/\.pack\.tar\.gz$/, "");
    if (manifestContentVersion(archive) === publishedVersion.get(id)) {
      result.unchanged++;
      rmSync(archive);
    } else {
      result.changed.push(fileName);
    }
    available.add(fileName);
  };
  const attempt = async (label: string, fn: () => Promise<{ fileName: string } | null>) => {
    try {
      const built = await fn();
      if (built) keepIfChanged(built.fileName);
    } catch (err) {
      result.failures.push({ pack: label, error: (err as Error).message });
      log(`FAILED ${label}: ${(err as Error).message}`);
    }
  };

  // Sea zones: an all-taxa pack plus one per taxon the zone has species for.
  // Only sea zone packs this run actually builds count as available: one the database no longer
  // has species for is gone after this run, so nothing may depend on it.
  for (const p of published.packs) if (p.type === "seaZone") available.delete(`${p.id}.pack.tar.gz`);
  // Packs build PACK_CONCURRENCY at a time: each stages in its own folder and writes its own
  // archive, and the bookkeeping above runs between awaits. Every sea zone pack is built before
  // any country pack, which checks whether its sea zones' packs exist.
  const zones = await seaZoneTaxa();
  log(`${zones.length} sea zones`);
  const zoneJobs = zones.flatMap((zone) =>
    [null, ...zone.taxa].flatMap((taxon) =>
      VARIANTS.map(
        (variant) => () =>
          attempt(`sea zone ${zone.name}${taxon ? ` ${taxon}` : ""} ${variant}`, () =>
            buildSeaZonePack(zone.name, outDir, taxon as TaxonClass | null, variant),
          ),
      ),
    ),
  );
  await mapWithConcurrency(zoneJobs, PACK_CONCURRENCY, (job) => job());

  const countries = await packCountries(opts.countries ?? null);
  log(`${countries.length} countries`);
  const countryJobs: Array<() => Promise<void>> = [];
  for (const country of countries) {
    const taxa = await taxaForCountry(country.id);
    for (const taxon of PACK_TAXA) {
      if (!taxa.has(taxon)) continue;
      for (const variant of VARIANTS) {
        countryJobs.push(() =>
          attempt(`${country.name} ${taxon} ${variant}`, () =>
            buildRegionPack(country.name, outDir, taxon, variant, {
              regionId: country.id,
              seaZonePackAvailable: (f) => available.has(f),
            }),
          ),
        );
      }
    }
  }
  await mapWithConcurrency(countryJobs, PACK_CONCURRENCY, (job) => job());
  log(
    `built ${result.built}: ${result.changed.length} changed, ${result.unchanged} unchanged, ${result.failures.length} failed`,
  );

  if (result.changed.length > 0) {
    // Indexes the changed packs and merges in every published one it didn't rebuild.
    execFileSync("npx", ["tsx", "src/build/build-pack-index.ts", outDir], {
      cwd: DATA_PIPELINE_DIR,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const index = JSON.parse(readFileSync(path.join(outDir, "pack-index.json"), "utf8")) as PackIndex;
    // A pack in this run's scope that it didn't build has lost all its species: dropped, so the
    // index never lists a pack whose data is gone. Not after a failed build, which proves nothing.
    if (result.failures.length === 0) {
      index.packs = index.packs.filter((p) => builtNow.has(p.id) || !isCoveredBy(p, opts.countries ?? null));
    }
    const shards = writePackStore(outDir, index, new Set(result.changed));
    log(`pack store: ${result.changed.length} pack(s) in ${shards.length} new shard(s)`);
    writeFileSync(path.join(outDir, "pack-index.json"), JSON.stringify(index, null, 2));
    result.index = index;
  } else {
    result.index = published;
  }
  return result;
}

function isCoveredBy(p: IndexPack, countries: string[] | null): boolean {
  if (p.type === "seaZone") return true;
  return !countries || (p.region != null && countries.includes(p.region));
}

/** Every dependency in the index resolves to a pack in it. */
export function checkIndex(index: PackIndex): string[] {
  const problems: string[] = [];
  const ids = new Set(index.packs.map((p) => p.id));
  for (const p of index.packs) {
    for (const dep of p.seaZoneDependencies ?? []) {
      if (!ids.has(dep)) problems.push(`${p.id} depends on ${dep}, which isn't in the index`);
    }
  }
  return problems;
}

/** Uploads the pack store's new shards and the index, and removes what nothing uses any more. */
export async function publishPacks(result: PacksResult, log: (m: string) => void = (m) => console.log(`[packs] ${m}`)) {
  if (!result.index) throw new Error("Nothing to publish");
  await publishPackStore(result.outDir, result.index, log);
}

export function cleanupPacksDir(dir: string) {
  if (existsSync(dir) && dir.startsWith(os.tmpdir())) rmSync(dir, { recursive: true, force: true });
}
