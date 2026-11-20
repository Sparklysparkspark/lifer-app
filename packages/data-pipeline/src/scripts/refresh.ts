// One command to refresh the species catalog, every region checklist, the rarity tiers and the
// offline packs, and (with --publish) ship them. Meant to run about once a quarter, or whenever
// taxonomy changes (splits, lumps, renames) should reach installs.
//
//   npm run refresh -w data-pipeline                                  everything that changed, no publish
//   npm run refresh -w data-pipeline -- --publish                     same, then publish if the gate passes
//   npm run refresh -w data-pipeline -- --countries="Costa Rica,Peru" rerun just these countries
//   npm run refresh -w data-pipeline -- --stages=tiers,packs,gate     just some stages
//   npm run refresh -w data-pipeline -- --refresh-occurrences         re-download GBIF data first
//   npm run refresh -w data-pipeline -- --full                        redo every country, not just what changed
//   npm run refresh -w data-pipeline -- --rescan --countries=...      reread those countries' raw downloads
//                                                                     (after synonym changes: the cached
//                                                                     province files keep names as scanned)
//   npm run refresh -w data-pipeline -- --resume                      continue the last run where it stopped
//   npm run refresh -w data-pipeline -- --accept-drift=<pack id>,...  publish past reviewed size changes
//   npm run refresh -w data-pipeline -- --allow-tier-skip             keep old tiers of countries with no province files
//   npm run refresh -w data-pipeline -- --fix-shared-inat-taxa        catalog stage: apply fix-shared-inat-taxa.ts
//   npm run refresh -w data-pipeline -- --stages=regions,packs,gate,publish --replace-sea-zones
//                                                                     regions stage: new sea zones and their lists only
//   npm run refresh -w data-pipeline -- --stages=regions --keep-provinces
//                                                                     regions stage: every step after the province build
//   npm run refresh -w data-pipeline -- --accept-stale=tiers,...      publish past stages older than their inputs
//   npm run refresh -w data-pipeline -- --map-source=<planet.pmtiles> also cut detailed country maps
//
// Prints the database it works on; --publish needs DATABASE_URL set (in the shell or the repo .env).
// A new run that changes data first dumps the database to data/backups/ (pipeline/dbSnapshot.ts).
//
// Stages, in order:
//   occurrences  GBIF country downloads (only with --refresh-occurrences, or when one is missing),
//                and the list of every species name in them for name reconciliation.
//   catalog      Names: link catalog species to the names GBIF, iNaturalist and eBird use now.
//                Missing species: add every species on iNaturalist or eBird lists the catalog lacks.
//                Merges: fold duplicate species into one.
//                IUCN: Red List status for every catalog species (backfill-iucn-status.ts).
//   enrich       Photos and descriptions for species that have none yet, and a retry for those
//                that came up empty. Then descriptions straight from Wikipedia for every species
//                without Wikipedia-sourced text, and a refetch of articles edited since.
//   regions      iNaturalist places for regions that have none, then province checklists, then the
//                vernacular groups (regions/vernacular.ts), then each country's and group's list
//                from its provinces (and the country's own iNaturalist list), then every sea
//                zone's list from the same downloads. From cached data (iNaturalist lists are
//                reused while younger than LIFER_INAT_CACHE_MAX_AGE_DAYS, 90).
//   places       Example city, most populous province and alias names per region (Natural Earth
//                populated places, data/reference/region-aliases.json).
//   gazetteer    The offline town list (GeoNames cities1000, CC BY 4.0, cached in data/raw/geonames;
//                delete the file there for a newer one): each town's country and province, only
//                changed rows written, stops if it would add over 8 MB to the seed or a known town is missing.
//   endemic      Which country each endemic species lives in, from the same downloads (only
//                countries whose download changed are reread).
//   tiers        Absolute rarity tiers for every checklist row, then the worldwide tier (a species'
//                easiest country), offline, in minutes.
//   vectors      Image and text embeddings (CLIP and the BioCLIP identification model) for species
//                that have none, so they can be suggested on import; occurrence stats.
//   packs        The photo store (every pack photo once, only new or changed ones written), then
//                every pack's checklist, keeping only those whose content changed.
//   maps         With --map-source=<Protomaps planet build URL or file> only: a detailed map per
//                country (pipeline/maps.ts), cut with the go-pmtiles CLI on PATH (PMTILES_BIN
//                overrides). Only countries whose boundary, the source or the zooms changed are cut.
//   gate         Refuses to publish on any data problem it knows how to detect (pipeline/gate.ts),
//                including catalog, regions, endemic, tiers or vectors older than their inputs.
//   publish      With --publish only: builds and checks the catalog seed, then uploads the photo
//                store's new shards and index, then the packs and index, removes orphaned files,
//                then uploads the catalog seed and its vector files.
// Every stage's start and end is logged in pipeline_runs, so --resume continues an interrupted run.
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "@lifer/core/config.js";
import { redactDatabaseUrl } from "../pipeline/doctorChecks.js";
import { BACKUP_DIR, dumpDatabase, snapshotStamp } from "../pipeline/dbSnapshot.js";
import { FRESH_STAGES } from "../pipeline/freshness.js";
import { applyPhotoLicensePolicy } from "../pipeline/photoLicensePolicy.js";
import { scorePendingReferencePhotos } from "@lifer/core/species/referencePortrait.js";
import { pool } from "../db.js";
import { findEbirdFormDuplicates, findMissingSpecies, insertMissingSpecies } from "./add-missing-species.js";
import { buildPacks, publishPacks, cleanupPacksDir, type PacksResult } from "../pipeline/packs.js";
import { buildPhotoStore, publishPhotoStore, type PhotoStoreBuild } from "../pipeline/photoStore.js";
import { publishCatalogSeed, verifyCatalogSeed } from "../pipeline/catalogPublish.js";
import { runGate, summarizeGate } from "../pipeline/gate.js";
import { findSpeciesSplits } from "./find-species-splits.js";
import { CATALOG_GBIF_CLASSES } from "../catalogClasses.js";
import { applyPlaces, loadPopulatedPlaces } from "../pipeline/places.js";
import { applyAliases } from "../pipeline/regionAliases.js";
import {
  MAX_GZIP_BYTES,
  applyGazetteer,
  assignRegions,
  gzipBytes,
  missingTowns,
  loadGazetteerSource,
  loadRegionRows,
  verifyGazetteer,
} from "../pipeline/gazetteer.js";
import { syncVernacularRegions } from "../regions/vernacular.js";
import { describeVernacularSync } from "./sync-vernacular-regions.js";
import { applySpeciesCorrections, loadSpeciesCorrections } from "../pipeline/speciesCorrections.js";
import { buildMapExtracts, mapCountries, publishMapExtracts } from "../pipeline/maps.js";

const PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.join(PIPELINE_DIR, "..", "..");
const DATA_DIR = path.join(PIPELINE_DIR, "data");
const BUILD_DIR = path.join(DATA_DIR, "build");
const GBIF_CACHE_DIR = path.join(DATA_DIR, "gbif-country-cache");
const ZIP_NAMES = path.join(BUILD_DIR, "zip-names.tsv");
const CURRENT_RUN = path.join(BUILD_DIR, "refresh-current-run.json");
// Kept between runs: the maps stage only cuts what changed since the extracts here.
const MAPS_OUT_DIR = path.join(BUILD_DIR, "map-extracts");
const STAGES = [
  "occurrences",
  "catalog",
  "enrich",
  "regions",
  "places",
  "gazetteer",
  "endemic",
  "tiers",
  "vectors",
  "packs",
  "maps",
  "gate",
  "publish",
] as const;
type Stage = (typeof STAGES)[number];

interface Options {
  stages: Stage[];
  countries: string[] | null;
  publish: boolean;
  full: boolean;
  refreshOccurrences: boolean;
  /** Reread the raw downloads instead of the cached province files (refresh-aggregate-cache). */
  rescan: boolean;
  resume: boolean;
  acceptDrift: string[] | "all";
  allowTierSkip: boolean;
  /** Apply fix-shared-inat-taxa.ts in the catalog stage (review data/review/shared-inat-taxa.tsv first). */
  fixSharedInatTaxa: boolean;
  /** The regions stage only replaces the sea zones and rebuilds their lists. */
  replaceSeaZones: boolean;
  /** The regions stage keeps the province lists as built and runs every step after them. */
  keepProvinces: boolean;
  /** Stages the gate may find older than their inputs without failing. */
  acceptStale: string[];
  /** The Protomaps planet build the maps stage cuts from. */
  mapSource: string | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const list = (name: string) =>
    value(name)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const publish = argv.includes("--publish");
  const requested = list("stages");
  for (const s of requested ?? [])
    if (!STAGES.includes(s as Stage)) throw new Error(`Unknown stage "${s}"; stages are ${STAGES.join(", ")}`);
  // Always in pipeline order, whatever order they were typed in: the gate must see the packs.
  const mapSource = value("map-source")?.trim() || null;
  // Maps run by default only when given a source: without one there is nothing to cut from.
  const stages = STAGES.filter((s) =>
    requested ? requested.includes(s) : (s !== "publish" || publish) && (s !== "maps" || mapSource != null),
  );
  if (stages.includes("maps") && !mapSource)
    throw new Error("The maps stage needs --map-source=<a Protomaps planet build URL or file>");
  const drift = value("accept-drift");
  const acceptStale = list("accept-stale") ?? [];
  for (const s of acceptStale)
    if (!(FRESH_STAGES as readonly string[]).includes(s))
      throw new Error(`--accept-stale takes ${FRESH_STAGES.join(", ")}, not "${s}"`);
  const replaceSeaZones = argv.includes("--replace-sea-zones");
  if (replaceSeaZones && !stages.includes("regions"))
    throw new Error("--replace-sea-zones runs in the regions stage; add regions to --stages");
  const keepProvinces = argv.includes("--keep-provinces");
  if (keepProvinces && (!stages.includes("regions") || list("countries")))
    throw new Error(
      "--keep-provinces runs in the regions stage, for every country; add regions to --stages and drop --countries",
    );
  return {
    stages,
    countries: list("countries"),
    publish,
    full: argv.includes("--full"),
    refreshOccurrences: argv.includes("--refresh-occurrences"),
    rescan: argv.includes("--rescan"),
    resume: argv.includes("--resume"),
    acceptDrift: argv.includes("--accept-all-drift") ? "all" : drift ? drift.split(",") : [],
    allowTierSkip: argv.includes("--allow-tier-skip"),
    fixSharedInatTaxa: argv.includes("--fix-shared-inat-taxa"),
    replaceSeaZones,
    keepProvinces,
    acceptStale,
    mapSource,
  };
}

const log = (stage: string, message: string) => console.log(`[refresh:${stage}] ${message}`);

function runScript(cwd: string, script: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("npx", ["tsx", script, ...args], { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

async function stageLogged(
  runId: string,
  stage: Stage,
  fn: () => Promise<Record<string, unknown> | void>,
  resume: boolean,
) {
  if (resume) {
    const done = await pool.query(
      `SELECT 1 FROM pipeline_runs WHERE run_id = $1 AND stage = $2 AND item = '' AND status = 'done'`,
      [runId, stage],
    );
    if (done.rowCount) {
      log(stage, "already done in this run, skipped");
      return;
    }
  }
  await pool.query(
    `INSERT INTO pipeline_runs (run_id, stage, status) VALUES ($1, $2, 'running')
     ON CONFLICT (run_id, stage, item) DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL`,
    [runId, stage],
  );
  const started = Date.now();
  try {
    const notes = (await fn()) ?? {};
    await pool.query(
      `UPDATE pipeline_runs SET status = 'done', finished_at = now(), notes = $3 WHERE run_id = $1 AND stage = $2 AND item = ''`,
      [runId, stage, JSON.stringify(notes)],
    );
    log(stage, `done in ${Math.round((Date.now() - started) / 60000)} min`);
  } catch (err) {
    await pool.query(
      `UPDATE pipeline_runs SET status = 'failed', finished_at = now(), notes = $3 WHERE run_id = $1 AND stage = $2 AND item = ''`,
      [runId, stage, JSON.stringify({ error: (err as Error).message })],
    );
    throw err;
  }
}

// ---------- stages ----------

async function occurrences(opts: Options) {
  // The regions stage downloads any missing country file itself; this re-downloads them when asked.
  if (opts.refreshOccurrences) {
    log("occurrences", "re-downloading GBIF country data");
    runScript(PIPELINE_DIR, "src/scripts/compute-provinces-bulk.ts", [
      "--cache-only",
      "--refresh-gbif-cache",
      ...(opts.countries ? [`--countries=${opts.countries.join(",")}`] : []),
    ]);
  }
  // Every species name in the country files, for name reconciliation. Only rebuilt when a file
  // is newer than the list, so it costs nothing on a run with no new downloads.
  const zips = existsSync(GBIF_CACHE_DIR) ? readdirSync(GBIF_CACHE_DIR).filter((f) => f.endsWith(".zip")) : [];
  const newest = Math.max(0, ...zips.map((f) => statSync(path.join(GBIF_CACHE_DIR, f)).mtimeMs));
  if (!existsSync(ZIP_NAMES) || statSync(ZIP_NAMES).mtimeMs < newest) {
    log("occurrences", `listing species names in ${zips.length} country files`);
    await listZipNames(
      zips.map((f) => path.join(GBIF_CACHE_DIR, f)),
      ZIP_NAMES,
    );
  }
  return { zips: zips.length };
}

/** "name<TAB>class<TAB>records" for every species name in the catalog's classes in the country
 *  files, summed. Other classes (insects and plants are most of GBIF) are skipped: nothing reads
 *  them, and tallying every name on Earth ran out of memory. */
async function listZipNames(zips: string[], out: string) {
  const totals = new Map<string, number>();
  const one = (zip: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("unzip", ["-p", zip]);
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      let header = true;
      rl.on("line", (line) => {
        if (header) {
          header = false;
          return;
        }
        const f = line.split("\t");
        if (!f[0] || !CATALOG_GBIF_CLASSES.has(f[3])) return;
        const key = `${f[0]}\t${f[3]}`;
        totals.set(key, (totals.get(key) ?? 0) + (Number(f[7]) || 1));
      });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip ${zip} exited ${code}`))));
      child.on("error", reject);
    });
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < zips.length) await one(zips[next++]);
    }),
  );
  writeFileSync(out, [...totals].map(([k, n]) => `${k}\t${n}`).join("\n") + "\n");
}

async function catalog(runId: string, opts: Options) {
  mkdirSync(BUILD_DIR, { recursive: true });
  log("catalog", "linking catalog species to current names");
  runScript(PIPELINE_DIR, "src/scripts/reconcile-species-names.ts", [
    "--zip-names",
    ZIP_NAMES,
    "--stage",
    "col,gbifkey,inat,ebird",
    "--checkpoint",
    // Per run: a later refresh checks every species again, a resumed one carries on.
    path.join(BUILD_DIR, `reconcile-checkpoint-${runId}.jsonl`),
    "--apply",
    "--report",
    path.join(BUILD_DIR, `reconcile-report-${new Date().toISOString().slice(0, 10)}.json`),
  ]);

  log("catalog", "adding species the catalog is missing");
  const { add, synonyms, links } = await findMissingSpecies({ offline: process.env.LIFER_INAT_OFFLINE === "1" });
  const added = add.length + synonyms.length + links.length > 0 ? await insertMissingSpecies(add, synonyms, links) : 0;
  log("catalog", `added ${added} species, linked ${links.length} respellings`);

  // Merges are vetted, never automatic: these go to a review file for species-merges.tsv.
  const reviewed = readFileSync(path.join(DATA_DIR, "reference", "species-merges.tsv"), "utf8");
  const formDupes = (await findEbirdFormDuplicates()).filter((d) => !reviewed.includes(d.oldId));
  if (formDupes.length > 0) {
    mkdirSync(path.join(DATA_DIR, "review"), { recursive: true });
    const file = path.join(DATA_DIR, "review", "ebird-form-duplicates.tsv");
    writeFileSync(
      file,
      formDupes
        .map((d) => [d.oldId, d.oldName, d.newId, d.newName, "eBird counts it as a form of this species"].join("\t"))
        .join("\n") + "\n",
    );
    log(
      "catalog",
      `${formDupes.length} birds eBird counts as forms of another catalog species, for review in ${path.relative(PIPELINE_DIR, file)}`,
    );
  }

  // Before the merge step, which applies the merges it adds to species-merges.tsv.
  if (opts.fixSharedInatTaxa) {
    log("catalog", "giving each iNaturalist taxon to one catalog species");
    runScript(PIPELINE_DIR, "src/scripts/fix-shared-inat-taxa.ts", ["--apply"]);
  }

  log("catalog", "merging duplicate species");
  runScript(PIPELINE_DIR, "src/scripts/merge-duplicate-species.ts", ["--apply"]);

  // After species are added, so a split's new species are in the catalog to point at. Installs
  // re-file photos under a split species by where they were taken.
  log("catalog", "finding species iNaturalist has split");
  const splits = await findSpeciesSplits(true, (m) => log("catalog", m));

  // Last: it reads the names, synonyms and splits the steps above just settled. One archive
  // download, plus a cached GBIF call for each listed bird, mammal, amphibian, reptile or coral
  // the names can't place (about 2,000 the first time, none after). Before tiers, which read it.
  log("catalog", "IUCN Red List status");
  runScript(PIPELINE_DIR, "src/scripts/backfill-iucn-status.ts", [
    "--apply",
    `--report=${path.join(BUILD_DIR, "iucn-status-report.tsv")}`,
  ]);
  await correctSpecies("catalog");
  return { added, linked: links.length, splits: splits.splits };
}

const ALL_TAXA =
  "aves,mammalia,actinopterygii,amphibia,squamata,testudines,corals,jellies_and_anemones,echinodermata,nudibranchs,marine_mollusks,cephalopoda,crustacea,sponges_tunicates_other";

async function enrich() {
  log("enrich", "photos and descriptions for listed species that have none");
  runScript(PIPELINE_DIR, "src/scripts/enrich-all-species.ts", [`--taxa=${ALL_TAXA}`, "--listed-only"]);
  // Retry species whose enrichment came up empty, since a rate limit can look like "no photo exists".
  log("enrich", "retrying species that came up with no photo");
  runScript(PIPELINE_DIR, "src/scripts/recheck-null-photo-species.ts", ["--listed-only"]);
  // Text from the Wikipedia article itself (the lead and its Description section, by the shared
  // rule), for species iNaturalist had no summary for or only its cut-off copy; then only the
  // articles edited since their text was fetched. After the photo passes, which can add species'
  // iNaturalist links to the cache this reads titles from.
  log("enrich", "descriptions from Wikipedia");
  runScript(PIPELINE_DIR, "src/scripts/backfill-descriptions.ts", []);
  log("enrich", "descriptions whose Wikipedia article changed");
  runScript(PIPELINE_DIR, "src/scripts/backfill-descriptions.ts", ["--refresh"]);
  // Public interest, which corrects photo-based tiers for species few people photograph.
  log("enrich", "Wikipedia pageviews");
  runScript(PIPELINE_DIR, "src/scripts/fetch-wiki-pageviews.ts", []);
  await correctSpecies("enrich");
}

// Last in each stage that writes names or Red List status, so a hand-checked correction always wins.
async function correctSpecies(stage: string) {
  const corrections = loadSpeciesCorrections();
  const missing = await applySpeciesCorrections(pool, corrections);
  log(stage, `species corrections: ${corrections.length - missing.length} applied`);
  if (missing.length > 0) log(stage, `species corrections matching no catalog species: ${missing.join(", ")}`);
}

const VENV_PYTHON = path.join(PIPELINE_DIR, ".venv", "bin", "python");

function requireVenv() {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      "The identification model's vectors need a Python environment once: python3 -m venv packages/data-pipeline/.venv && " +
        "packages/data-pipeline/.venv/bin/pip install -r packages/data-pipeline/python/requirements.txt",
    );
  }
}

// Embeddings for species that have none (both matching models) and the occurrence stats the
// obscure/Ghost/Lost flags read. Without vectors a species can never be suggested on import.
async function vectors() {
  // First, so photos edited by hand since the enrich stage are vetted before they get vectors.
  log("vectors", "photo license policy");
  await applyPhotoLicensePolicy(pool, (m) => log("vectors", m));
  log("vectors", "CLIP reference photo embeddings");
  runScript(PIPELINE_DIR, "src/scripts/backfill-reference-embeddings.ts", []);
  log("vectors", "CLIP text embeddings");
  runScript(PIPELINE_DIR, "src/scripts/backfill-text-embeddings.ts", []);
  requireVenv();
  log("vectors", "identification model (BioCLIP) vectors");
  execFileSync(VENV_PYTHON, [path.join(PIPELINE_DIR, "python", "compute_id_model_vectors.py")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  // After both models' vectors, since a main photo that isn't a portrait swaps them with a gallery photo.
  const kinds = await scorePendingReferencePhotos();
  log("vectors", `reference photo kinds: ${kinds.scored} scored, ${kinds.swapped} main photos swapped for a portrait`);
  log("vectors", "occurrence stats for species that have none");
  runScript(PIPELINE_DIR, "src/scripts/fetch-occurrence-stats.ts", ["--only-missing"]);
}

async function regions(opts: Options) {
  if (opts.replaceSeaZones) {
    // The sea zone chain alone: checklists and tiers don't read sea zones, so nothing else reruns.
    log("regions", "replacing the sea zones, then their habitats and lists");
    runScript(PIPELINE_DIR, "src/scripts/replace-sea-zones.ts", ["--apply"]);
    runScript(PIPELINE_DIR, "src/scripts/fetch-worms-environment.ts", []);
    runScript(PIPELINE_DIR, "src/scripts/compute-sea-zones-offline.ts", ["--apply"]);
    return { seaZonesOnly: true };
  }
  // Without it province lists leave out eBird's region lists, so two runs differ by environment.
  const ebirdKey = Boolean(process.env.EBIRD_API_KEY?.trim());
  if (!ebirdKey)
    log(
      "regions",
      "WARNING: EBIRD_API_KEY is not set; province lists are built without eBird's region lists and will differ from a run with it",
    );
  // Regions without an iNaturalist place never get their lists checked against iNaturalist.
  runScript(PIPELINE_DIR, "src/scripts/resolve-inat-places.ts", []);
  // eBird's own region codes, before the province build asks eBird for each province's list.
  runScript(PIPELINE_DIR, "src/scripts/fix-ebird-region-codes.ts", ["--apply"]);
  const args = ["--apply"];
  if (opts.countries) args.push(`--countries=${opts.countries.join(",")}`);
  // New downloads or an explicit country list mean those countries are rebuilt from scratch;
  // otherwise the run continues where the last one left off.
  // Not when resuming: that keeps the provinces already rebuilt.
  if (!opts.resume && (opts.full || opts.countries || opts.refreshOccurrences)) args.push("--reset-checkpoint");
  if (opts.rescan) args.push("--rescan");
  if (opts.keepProvinces) log("regions", "keeping the province lists as built (--keep-provinces)");
  else runScript(PIPELINE_DIR, "src/scripts/refresh-all-provinces.ts", args);
  // Provinces into their vernacular groups (country > group > province), including any the
  // province build just created, before group and country lists are built from them.
  const vernacular = await syncVernacularRegions(pool, true);
  for (const line of describeVernacularSync(vernacular, true)) log("regions", line);
  // Species the catalog stage added after a province was built, from the cached lists.
  runScript(PIPELINE_DIR, "src/scripts/add-new-species-to-checklists.ts", ["--apply"]);
  // iNaturalist photo counts per place: what tiers are rated on, and what tells an escaped pet
  // from a sensitive species whose GBIF records are hidden.
  runScript(PIPELINE_DIR, "src/scripts/refresh-inat-counts.ts", []);
  runScript(PIPELINE_DIR, "src/scripts/remove-escapes.ts", ["--apply"]);
  // Thin eBird-only listings no open list supports (data/review/ebird-only-unsupported.tsv lists them).
  runScript(PIPELINE_DIR, "src/scripts/check-ebird-only.ts", ["--apply"]);
  // Each country's list from its provinces and its own iNaturalist list, then escapes again: the
  // country's iNaturalist list can bring back one its provinces dropped.
  runScript(PIPELINE_DIR, "src/scripts/build-country-checklists.ts", [
    "--apply",
    ...(opts.countries ? [`--countries=${opts.countries.join(",")}`] : []),
  ]);
  runScript(PIPELINE_DIR, "src/scripts/remove-escapes.ts", ["--apply"]);
  // Birds eBird counts only as escapees come off, and its Naturalized and Provisional ones are
  // marked introduced, at every level: after the country lists, which can bring them back.
  runScript(PIPELINE_DIR, "src/scripts/apply-ebird-exotics.ts", ["--apply"]);
  // Introduced or native, from iNaturalist's establishment status per place: sets the Introduced
  // and Vagrant flags the tiers and cards use.
  runScript(PIPELINE_DIR, "src/scripts/apply-introduced-flags.ts", ["--apply"]);
  // Every sea zone's fish and marine mammals, from the same country downloads in one pass. Always
  // every zone and every coastal download, even with --countries: a zone's records come from all
  // the countries around it.
  // WoRMS habitats for fish and marine mammals, which the sea zones use to leave freshwater-only
  // species off and keep a marine species at the edge of its range.
  runScript(PIPELINE_DIR, "src/scripts/fetch-worms-environment.ts", []);
  runScript(PIPELINE_DIR, "src/scripts/compute-sea-zones-offline.ts", ["--apply"]);
  return {
    countries: opts.countries ?? "all",
    groupsCreated: vernacular.groupsCreated,
    nested: vernacular.provincesNested,
    ebirdKey,
  };
}

async function places() {
  const stats = await applyPlaces(pool, await loadPopulatedPlaces());
  log("places", `${stats.withCity} of ${stats.regions} regions have an example city, ${stats.changed} updated`);
  if (stats.countriesWithoutCity.length > 0)
    log(
      "places",
      `no city for ${stats.countriesWithoutCity.length} countries: ${stats.countriesWithoutCity.join(", ")}`,
    );
  const aliases = await applyAliases(pool);
  log("places", `${aliases.written} regions got new alias lists`);
  for (const m of aliases.unmatched) log("places", `alias entry matches no region: ${m.join(" / ")}`);
  for (const c of aliases.clashes) log("places", `alias is another region's name, skipped: ${c}`);
  for (const d of aliases.duplicates) log("places", `two countries named ${d}: merge the rows`);
  return { ...stats, aliasesWritten: aliases.written };
}

async function gazetteer() {
  const source = await loadGazetteerSource();
  const places = assignRegions(await loadRegionRows(pool), source.places, source.iso3Of);
  const bytes = gzipBytes(places);
  log("gazetteer", `${places.length} places, about ${(bytes / 1024 / 1024).toFixed(1)} MB compressed`);
  if (bytes > MAX_GZIP_BYTES)
    throw new Error(`The town list is over ${MAX_GZIP_BYTES / 1024 / 1024} MB compressed; nothing was written`);
  const missing = missingTowns(places);
  if (missing.length > 0) throw new Error(`The town list lacks ${missing.join(", ")}; nothing was written`);
  const applied = await applyGazetteer(pool, places);
  log("gazetteer", `${applied.written} written, ${applied.removed} removed`);
  for (const line of await verifyGazetteer(pool)) log("gazetteer", line);
  return { ...applied, gzipBytes: bytes };
}

async function endemic(opts: Options) {
  runScript(PIPELINE_DIR, "src/scripts/compute-endemic-countries.ts", ["--apply", ...(opts.full ? ["--full"] : [])]);
}

async function tiers(opts: Options) {
  // Checklists changed, so their tier inputs are re-read from the province data before rating.
  runScript(PIPELINE_DIR, "src/scripts/compute-local-tiers.ts", [
    "--apply",
    "--inputs",
    "--calibrate",
    ...(opts.allowTierSkip ? ["--allow-skip"] : []),
    ...(opts.countries ? [`--countries=${opts.countries.join(",")}`] : []),
  ]);
  // Worldwide tiers come from the local ones, so always every species.
  runScript(PIPELINE_DIR, "src/scripts/compute-global-tiers.ts", ["--apply"]);
}

/** Publishing needs a gate that passed in this same run, not just built packs. */
async function assertGatePassed(runId: string): Promise<void> {
  const gate = await pool.query<{ notes: { ok?: boolean } | null }>(
    `SELECT notes FROM pipeline_runs WHERE run_id = $1 AND stage = 'gate' AND item = '' AND status = 'done'`,
    [runId],
  );
  if (gate.rows[0]?.notes?.ok !== true)
    throw new Error("publish needs the gate stage to pass in the same run (add gate to --stages)");
}

/** A resumed run does what the run it continues was asked to (its countries, --publish). Flags
 *  given now (say --allow-tier-skip after the tiers stage stopped) are added, and come first so a
 *  value given now (--countries=, --stages=) wins over the earlier run's. */
export function resumeArgv(given: string[], previous: string[]): string[] {
  return [...new Set([...given, ...previous.filter((a) => a !== "--resume")])];
}

// Stages that write to the database; a run of only the others needs no snapshot. The gazetteer
// writes only its own table, rebuilt whole from the cached download, so it needs none either.
const READ_ONLY_STAGES: Stage[] = ["occurrences", "packs", "maps", "gate", "publish"];
export const NO_SNAPSHOT_STAGES: Stage[] = [...READ_ONLY_STAGES, "gazetteer"];
const KEEP_SNAPSHOTS = 3;

/** A pg_dump of the database before reconcile, merges, escapes and checklist rebuilds change it.
 *  Only the newest few of refresh's own are kept (each is several GB); other dumps are left alone. */
async function snapshotBeforeChanges(opts: Options) {
  if (opts.stages.every((s) => NO_SNAPSHOT_STAGES.includes(s))) return;
  const file = path.join(BACKUP_DIR, `lifer-db-before-refresh-${snapshotStamp()}.dump`);
  await dumpDatabase(DATABASE_URL, file, (m) => console.log(`[refresh] snapshot: ${m}`));
  const own = readdirSync(BACKUP_DIR)
    .filter((f) => /^lifer-db-before-refresh-.*\.dump$/.test(f))
    .sort()
    .reverse();
  for (const f of own.slice(KEEP_SNAPSHOTS)) rmSync(path.join(BACKUP_DIR, f));
}

// ---------- main ----------

async function main() {
  const given = process.argv.slice(2);
  mkdirSync(BUILD_DIR, { recursive: true });
  const previous = existsSync(CURRENT_RUN)
    ? (JSON.parse(readFileSync(CURRENT_RUN, "utf8")) as { runId: string; argv?: string[] })
    : null;
  const resuming = given.includes("--resume") && previous != null;
  const argv = resuming && previous.argv ? resumeArgv(given, previous.argv) : given;
  const opts = parseArgs(argv);
  const runId = resuming ? previous.runId : randomUUID();
  // Unset, every script falls back to localhost:5432/lifer, so say which database this is.
  const explicitDb = Boolean(process.env.DATABASE_URL?.trim());
  console.log(
    `[refresh] database ${redactDatabaseUrl(DATABASE_URL)}${explicitDb ? "" : " (default; DATABASE_URL isn't set)"}`,
  );
  if (opts.stages.includes("publish") && !explicitDb)
    throw new Error("--publish needs DATABASE_URL set to the database you mean to publish from");
  if (!resuming) {
    // Before anything runs, not hours in at the vectors stage.
    if (opts.stages.includes("vectors")) requireVenv();
    await snapshotBeforeChanges(opts);
    writeFileSync(CURRENT_RUN, JSON.stringify({ runId, startedAt: new Date().toISOString(), argv: given }));
  }
  console.log(
    `[refresh] run ${runId}: stages ${opts.stages.join(", ")}${opts.countries ? ` for ${opts.countries.join(", ")}` : ""}`,
  );

  let packs: PacksResult | null = null;
  let photos: PhotoStoreBuild | null = null;
  let mapsBuilt = false;
  try {
    for (const stage of opts.stages) {
      if (stage === "occurrences") await stageLogged(runId, stage, () => occurrences(opts), opts.resume);
      if (stage === "catalog") await stageLogged(runId, stage, () => catalog(runId, opts), opts.resume);
      if (stage === "enrich") await stageLogged(runId, stage, enrich, opts.resume);
      if (stage === "vectors") await stageLogged(runId, stage, vectors, opts.resume);
      if (stage === "regions") await stageLogged(runId, stage, () => regions(opts), opts.resume);
      if (stage === "places") await stageLogged(runId, stage, places, opts.resume);
      if (stage === "gazetteer") await stageLogged(runId, stage, gazetteer, opts.resume);
      if (stage === "endemic") await stageLogged(runId, stage, () => endemic(opts), opts.resume);
      if (stage === "tiers") await stageLogged(runId, stage, () => tiers(opts), opts.resume);
      if (stage === "packs") {
        await stageLogged(
          runId,
          stage,
          async () => {
            photos = await buildPhotoStore({
              outDir: path.join(BUILD_DIR, "photo-store"),
              log: (m) => log("packs", m),
            });
            packs = await buildPacks({ countries: opts.countries, outDir: path.join(BUILD_DIR, "packs-out") });
            return {
              built: packs.built,
              changed: packs.changed.length,
              failures: packs.failures,
              newPhotoBytes: photos.newBytes,
            };
          },
          false,
        );
      }
      if (stage === "maps") {
        await stageLogged(
          runId,
          stage,
          async () => {
            const result = await buildMapExtracts({
              countries: await mapCountries(pool, opts.countries),
              source: opts.mapSource!,
              outDir: MAPS_OUT_DIR,
              partial: opts.countries != null,
              log: (m) => log("maps", m),
            });
            mapsBuilt = true;
            if (result.failures.length > 0)
              throw new Error(`${result.failures.length} map extract(s) failed (see above)`);
            return { extracts: result.index.extracts.length, changed: result.changed.length };
          },
          false,
        );
      }
      if (stage === "gate") {
        await stageLogged(
          runId,
          stage,
          async () => {
            const report = await runGate({
              index: (packs as PacksResult | null)?.index ?? null,
              acceptDrift: opts.acceptDrift,
              freshness: { acceptStale: opts.acceptStale },
            });
            console.log(summarizeGate(report));
            if ((packs as PacksResult | null)?.failures.length) {
              report.ok = false;
              console.log(`  ${(packs as PacksResult).failures.length} pack(s) failed to build (see above)`);
            }
            if (!report.ok && opts.publish) throw new Error("The gate failed; nothing was published");
            return { ok: report.ok, failures: report.failures.length };
          },
          false,
        );
      }
      if (stage === "publish") {
        if (!packs) throw new Error("publish needs the packs stage in the same run");
        await assertGatePassed(runId);
        const built = packs as PacksResult;
        await stageLogged(
          runId,
          stage,
          async () => {
            // The catalog seed carries what packs don't (worldwide tiers, traits, merges, vectors):
            // a fresh install bootstraps from it. Built and checked before anything is uploaded, so
            // a seed that fails to build leaves every published file as it was.
            const seedDir = path.join(BUILD_DIR, "catalog-seed");
            mkdirSync(seedDir, { recursive: true });
            // The same database this run used, dumped with a pg_dump matching the Postgres installs
            // restore into (18, desktop and server alike): build-catalog-seed.ts picks it
            // (PG_DUMP_BIN, a desktop build's, the Docker container's, PATH's; pipeline/pgDump.ts).
            runScript(
              PIPELINE_DIR,
              "src/scripts/build-catalog-seed.ts",
              [path.join(seedDir, "lifer-catalog-seed.sql.gz")],
              { DATABASE_URL },
            );
            await verifyCatalogSeed(seedDir);
            // Photos first: a pack's photos must be fetchable the moment the pack is listed.
            if (photos) await publishPhotoStore(photos, (m) => log("publish", m));
            // The seed still goes out when no pack changed: vectors, merges or worldwide tiers may have.
            if (built.changed.length > 0) await publishPacks(built);
            else log("publish", "no pack changed");
            publishCatalogSeed(seedDir, (m) => log("publish", m));
            if (mapsBuilt) publishMapExtracts(MAPS_OUT_DIR, (m) => log("publish", m));
            log("publish", built.changed.length > 0 ? "packs and catalog seed published" : "catalog seed published");
          },
          false,
        );
        cleanupPacksDir(built.outDir);
      }
    }
    console.log(`[refresh] run ${runId} finished`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[refresh] ${(err as Error).message}`);
    process.exit(1);
  });
}
