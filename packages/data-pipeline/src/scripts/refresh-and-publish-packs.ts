// Fully-automated "keep every published country×taxon pack in sync with its own source data"
// pass — the piece build-and-publish-all-packs.ts deliberately doesn't do: that script only ever
// builds a country's pack ONCE (it skips anything already in the pack index, forever, so a
// country whose checklist gets recomputed later — e.g. refresh-all-provinces.ts's world sweep —
// never gets its published pack refreshed to match). This is the general "did the underlying
// data actually change, and is it actually ready to ship" pass meant to run repeatedly/on a
// schedule, safe to re-run at any time with nothing changed (a no-op) or with a lot changed (a
// full re-publish), without ever leaving stale/orphaned assets behind.
//
// Two gates, per country×taxon combo, before anything gets rebuilt:
//   1. READY: every species in this country+taxon's checklist has been through enrichment at
//      least once (species.enriched_at IS NOT NULL). This is what naturally holds fish packs
//      back until enrich-all-species.ts finishes covering them — no fish-specific special case
//      anywhere in this file, it just falls out of the same rule every taxon gets.
//   2. CHANGED: build it locally regardless (cheap — no GBIF calls, just already-computed DB rows
//      + already-cached reference photos) and compare its content hash (manifest.contentVersion,
//      from build-region-pack.ts's own contentHash()) against whatever's currently published for
//      that exact pack id. Only a real content difference gets uploaded — this is what keeps a
//      repeated run from re-publishing byte-identical packs over and over.
//
// The published pack-index.json is fetched fresh at the start and MERGED with (not replaced by)
// whatever this run rebuilds — build-pack-index.ts itself only ever indexes whatever's in the
// directory you point it at, so running it against a directory containing only today's changed
// packs would otherwise silently drop every untouched country from the index. Merging by id
// keeps every previously-published pack listed even though this run never touched its file.
//
// After publishing, a final cleanup pass deletes any GitHub release asset that isn't referenced
// by the merged index — the automated version of the manual "dead weight" cleanup done earlier
// (238 orphaned pre-taxon-split packs) for whatever future format/naming change eventually causes
// the same kind of orphaning again.
//
// Usage: npx tsx src/scripts/refresh-and-publish-packs.ts [--countries=Canada,Finland] [--dry-run]
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { pool } from "../db.js";
import { regionPackFileName } from "../build/pack-id.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const DATA_PIPELINE_DIR = path.join(REPO_ROOT, "packages/data-pipeline");
const RELEASE_TAG = "packs-latest";
const PACK_INDEX_URL = `https://github.com/Sparklysparkspark/lifer-app/releases/download/${RELEASE_TAG}/pack-index.json`;

// Same list build-and-publish-all-packs.ts already maintains (mirrors build-region-pack.ts's own
// local TAXON_CLASSES tuple) — duplicated rather than imported, matching that file's own existing
// pattern/reasoning for why this one small array isn't worth a shared module.
const TAXON_CLASSES = [
  "aves",
  "mammalia",
  "actinopterygii",
  "elasmobranchii",
  "aquatic_mammalia",
  "amphibia",
  "squamata",
  "testudines",
  "crocodylia",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "collector_shells",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
];

interface IndexPack {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  sizeBytes: number;
  speciesCount: number;
  contentVersion: string;
  scientificNames: string[];
  url: string;
  seaZoneDependencies?: string[];
}

interface PackIndex {
  generatedAt: string;
  packs: IndexPack[];
}

function run(label: string, args: string[], cwd: string): string {
  console.log(`[refresh-and-publish-packs] ${label}: npx ${args.join(" ")}`);
  return execFileSync("npx", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function fetchPublishedIndex(): Promise<PackIndex> {
  const res = await fetch(PACK_INDEX_URL);
  if (!res.ok) {
    if (res.status === 404) return { generatedAt: new Date(0).toISOString(), packs: [] };
    throw new Error(`Couldn't fetch the published pack index: HTTP ${res.status}`);
  }
  return (await res.json()) as PackIndex;
}

interface PackManifestCore {
  type: "region" | "seaZone";
  region?: string;
  taxon?: string | null;
  contentVersion: string;
}

function readManifestContentVersion(archivePath: string): string {
  const extractDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-refresh-"));
  try {
    tar.extract({ file: archivePath, cwd: extractDir, sync: true });
    const manifest = JSON.parse(readFileSync(path.join(extractDir, "manifest.json"), "utf8")) as PackManifestCore;
    return manifest.contentVersion;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

// A country's own checklist may live directly on its region_species rows (unsplit countries) or
// entirely on its province children's rows (split countries — see update-pack.ts's own comment:
// "region_species rows only ever live on the leaf region, never duplicated onto the country row
// above it"), so readiness has to check both places at once, not just the country row.
async function taxonReadiness(countryId: string, taxon: string): Promise<{ total: number; enriched: number }> {
  const res = await pool.query<{ total: string; enriched: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE s.enriched_at IS NOT NULL) AS enriched
     FROM region_species rs
     JOIN regions r ON r.id = rs.region_id
     JOIN species s ON s.id = rs.species_id
     WHERE (r.id = $1 OR r.parent_id = $1) AND s.taxon_class = $2`,
    [countryId, taxon],
  );
  return { total: Number(res.rows[0].total), enriched: Number(res.rows[0].enriched) };
}

async function computedCountries(namesFilter: string[] | null): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT DISTINCT r.id, r.name
     FROM regions r
     JOIN regions cont ON cont.id = r.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
     LEFT JOIN regions prov ON prov.parent_id = r.id
     WHERE (r.occurrence_computed_at IS NOT NULL OR prov.occurrence_computed_at IS NOT NULL)
       ${namesFilter ? "AND r.name = ANY($1)" : ""}
     ORDER BY r.name`,
    namesFilter ? [namesFilter] : [],
  );
  return res.rows;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.split("=")[1];
  const namesFilter = countriesArg ? countriesArg.split(",").map((c) => c.trim()).filter(Boolean) : null;

  const publishedIndex = await fetchPublishedIndex();
  const publishedById = new Map(publishedIndex.packs.map((p) => [p.id, p]));
  console.log(`[refresh-and-publish-packs] ${publishedIndex.packs.length} packs currently published`);

  const countries = await computedCountries(namesFilter);
  console.log(`[refresh-and-publish-packs] ${countries.length} computed countries to check`);

  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-refresh-scratch-"));
  const changedFiles: string[] = [];
  let checked = 0;
  let notReady = 0;
  let unchanged = 0;
  let changed = 0;

  try {
    for (const country of countries) {
      for (const taxon of TAXON_CLASSES) {
        const { total, enriched } = await taxonReadiness(country.id, taxon);
        if (total === 0) continue; // build-region-pack.ts would skip this anyway — no species, no pack.
        checked++;
        if (enriched < total) {
          notReady++;
          continue;
        }

        run(
          `build ${country.name} / ${taxon}`,
          ["tsx", "src/build/build-region-pack.ts", country.name, scratchDir, `--taxon=${taxon}`],
          DATA_PIPELINE_DIR,
        );
        const fileName = regionPackFileName(country.name, taxon);
        const archivePath = path.join(scratchDir, fileName);
        if (!existsSync(archivePath)) continue; // build-region-pack.ts itself decided there's nothing to write.

        const newVersion = readManifestContentVersion(archivePath);
        const publishedVersion = publishedById.get(path.basename(fileName, ".pack.tar.gz"))?.contentVersion;
        if (newVersion === publishedVersion) {
          unchanged++;
          rmSync(archivePath);
        } else {
          changed++;
          changedFiles.push(fileName);
        }
      }
    }

    console.log(
      `[refresh-and-publish-packs] checked ${checked} ready-or-not combos: ${notReady} not fully enriched yet, ${unchanged} unchanged, ${changed} changed`,
    );

    if (changed === 0) {
      console.log(`[refresh-and-publish-packs] nothing changed — done, no publish needed.`);
      return;
    }

    if (dryRun) {
      console.log(`[refresh-and-publish-packs] DRY RUN — would publish: ${changedFiles.join(", ")}`);
      return;
    }

    // build-pack-index.ts only ever indexes whatever .pack.tar.gz files are actually sitting in
    // the directory it's pointed at — scratchDir at this point holds ONLY the changed files, so
    // this produces a partial index covering just them, not a replacement for the full one.
    run("build partial index", ["tsx", "src/build/build-pack-index.ts", scratchDir], DATA_PIPELINE_DIR);
    const partialIndex = JSON.parse(readFileSync(path.join(scratchDir, "pack-index.json"), "utf8")) as PackIndex;

    // Merge: every previously-published pack stays listed unless this run rebuilt it, in which
    // case the freshly-built entry replaces it. Never drops an untouched country from the index.
    const mergedById = new Map(publishedIndex.packs.map((p) => [p.id, p]));
    for (const pack of partialIndex.packs) mergedById.set(pack.id, pack);
    const mergedIndex: PackIndex = { generatedAt: new Date().toISOString(), packs: [...mergedById.values()] };
    writeFileSync(path.join(scratchDir, "pack-index.json"), JSON.stringify(mergedIndex, null, 2));

    run("publish", ["tsx", "src/scripts/publish-packs.ts", scratchDir], DATA_PIPELINE_DIR);

    // Safety net: delete any release asset the merged index no longer references — protects
    // against exactly the kind of orphaned-asset clutter a future pack-naming change would
    // otherwise leave behind (the manual cleanup this same problem needed earlier this session).
    const expectedNames = new Set(mergedIndex.packs.map((p) => `${p.id}.pack.tar.gz`));
    expectedNames.add("pack-index.json");
    const actualNames = JSON.parse(execSync(`gh release view ${RELEASE_TAG} --json assets --jq '[.assets[].name]'`, { encoding: "utf8" })) as string[];
    const orphaned = actualNames.filter((n) => !expectedNames.has(n));
    if (orphaned.length > 0) {
      console.log(`[refresh-and-publish-packs] deleting ${orphaned.length} orphaned asset(s): ${orphaned.join(", ")}`);
      for (const name of orphaned) {
        execSync(`gh release delete-asset ${RELEASE_TAG} ${JSON.stringify(name)} --yes`);
      }
    } else {
      console.log(`[refresh-and-publish-packs] no orphaned assets found`);
    }

    console.log(`[refresh-and-publish-packs] done. ${changed} pack(s) republished.`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
