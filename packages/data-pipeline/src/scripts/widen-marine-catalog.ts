// Widens the catalog's marine groups (docs/plans/marine-coverage.md, option C) and lists the new
// species everywhere the existing stages would, in one resumable command:
//
//   npm run widen-marine-catalog -w data-pipeline                     dry run: counts per group and country, nothing written
//   npm run widen-marine-catalog -w data-pipeline -- --apply          everything below, in order
//   npm run widen-marine-catalog -w data-pipeline -- --apply --resume continue a stopped run
//   ... --stages=species,checklists        some stages only (pipeline order whatever the order typed)
//   ... --countries=Belize,Honduras        dry run: print these countries (all go to the TSV)
//   ... --ignore-top-up                    run although the gallery top-up has not finished
//
// Stages, in order (each is incremental: a rerun only does what is left):
//   species      Adds iNaturalist-observed species of WIDENED_MARINE_CLADES (add-missing-species.ts:
//                bivalves, chitons, ceriths, nerites, limpets, sea hares and sap-sucking and
//                headshield slugs, octocorals, zoanthids, corallimorphs, black corals, sea cucumbers,
//                brittle and feather stars, barnacles, mantis shrimp; marine only). Offline: taxon
//                details are cached, clade ids and families come from the iNaturalist dump. Their ids
//                go to data/build/marine-widening-species.txt for the photo stage.
//   checklists   Province rows from the cached place lists, country lists rebuilt, sea zone rows from
//                the OBIS cache, country OBIS rows (build-country-marine-obis.ts), then 6c membership
//                and vagrant flags offline and its follow-ups (escapes, eBird exotics from cache,
//                introduced flags), as the refresh regions stage runs them.
//   audit        6b catalog audit fixes (fix-catalog-audit.ts).
//   tiers        Local then worldwide tiers (the refresh tiers stage).
//   photos       Main photo, Wikipedia summary and gallery for the new species (enrich-all-species),
//                then their galleries topped up to 6 (top-up-galleries, paced as the gallery top-up
//                is), then photo-withheld flags from cache. About 15 s a species; stops cleanly under
//                20 GB free.
//   vectors      CLIP and BioCLIP vectors for species without them, photo kinds (the refresh vectors
//                stage, without its GBIF occurrence-stats step).
// Then the republish's own `refresh --stages=packs,gate,publish` builds packs and the seed.
//
// An --apply run refuses to start while the gallery top-up is running or unfinished
// (data/logs/top-up-status.json), and below 20 GB free. It holds the catalog write lock
// (/tmp/lifer-catalog-write.lock) for the whole run, and the first run backs up the tables it
// touches to data/backups/. A dry run reads the database in read-only transactions.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "@lifer/core/config.js";
import { COUNTRIES_SQL } from "@lifer/core/regions/regionTree.js";
import { pool } from "../db.js";
import { BACKUP_DIR, dumpDatabase, snapshotStamp } from "../pipeline/dbSnapshot.js";
import { cachedPlaceCounts } from "../regions/inatChecklist.js";
import {
  findMissingSpecies,
  insertMissingSpecies,
  WIDENED_MARINE_CLADES,
  type NewSpecies,
} from "./add-missing-species.js";
import { parseArgs as refreshArgs, tiers, vectors } from "./refresh.js";

const PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(PIPELINE_DIR, "data");
const BUILD_DIR = path.join(DATA_DIR, "build");
const LOG_DIR = path.join(DATA_DIR, "logs");
export const SPECIES_FILE = path.join(BUILD_DIR, "marine-widening-species.txt");
const CURRENT_RUN = path.join(BUILD_DIR, "marine-widening-current-run.json");
const LOCK_DIR = "/tmp/lifer-catalog-write.lock";
const MIN_FREE_GB = 20;
export const STAGES = ["species", "checklists", "audit", "tiers", "photos", "vectors"] as const;
type Stage = (typeof STAGES)[number];
const MARINE_CLASSES = "marine_mollusks,nudibranchs,corals,echinodermata,crustacea";
// Tables the stages write (rows, flags, tiers, names); a restore of this dump undoes the run
// except photos and vectors, which only add rows for the new species.
const BACKUP_TABLES = [
  "species",
  "species_synonyms",
  "species_traits",
  "species_rarity",
  "regions",
  "region_species",
  "region_species_hotspots",
  "region_group_effort",
  "region_unmatched_taxa",
  "sea_zone_species",
];
const log = (m: string) => console.log(`[widen-marine] ${m}`);

/** Why the gallery top-up blocks a run, or null. It must finish first: both read iNaturalist
 *  under one daily budget, and both write reference photos. */
export function topUpBlocker(
  status: { state?: string; supervisor_pid?: number } | null,
  supervisorAlive: boolean,
  topUpProcess: boolean,
): string | null {
  if (supervisorAlive) return `the gallery top-up supervisor is running (pid ${status?.supervisor_pid ?? "?"})`;
  if (topUpProcess) return "a top-up-galleries run is in progress";
  if (status && status.state !== "done")
    return `the gallery top-up has not finished (state "${status.state}"); pass --ignore-top-up only if the maintainer has decided to skip the rest`;
  return null;
}

function checkTopUp(ignore: boolean): void {
  const statusFile = path.join(LOG_DIR, "top-up-status.json");
  const status = existsSync(statusFile) ? (JSON.parse(readFileSync(statusFile, "utf8")) as { state?: string }) : null;
  const pidFile = path.join(LOG_DIR, "top-up-supervisor.pid");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  const alive = ((): boolean => {
    try {
      return pid ? process.kill(pid, 0) : false;
    } catch {
      return false;
    }
  })();
  const running = ((): boolean => {
    try {
      return execFileSync("pgrep", ["-f", "top-up-galleries"], { encoding: "utf8" }).trim().length > 0;
    } catch {
      return false; // pgrep exits 1 when nothing matches
    }
  })();
  // A live supervisor or top-up is never overridden: they would compete for iNaturalist.
  const blocker = topUpBlocker(status, alive, running);
  if (blocker && (alive || running || !ignore)) throw new Error(`Not starting: ${blocker}`);
}

function freeGb(): number {
  const s = statfsSync(DATA_DIR);
  return (s.bavail * s.bsize) / 1024 ** 3;
}
function checkDisk(what: string): void {
  const free = freeGb();
  if (free < MIN_FREE_GB)
    throw new Error(`Stopping before ${what}: ${free.toFixed(1)} GB free, under ${MIN_FREE_GB} GB`);
}

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  execFileSync("npx", ["tsx", script, ...args], {
    cwd: PIPELINE_DIR,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}
const OFFLINE = { LIFER_INAT_OFFLINE: "1" };

/** Species of the widened clades only: the regular catalog stage adds the rest. */
export function widenedOnly(add: NewSpecies[]): NewSpecies[] {
  return add.filter((a) => a.clade != null && WIDENED_MARINE_CLADES.has(a.clade));
}

/** Ids already listed plus new ones, one per line: a rerun of the species stage adds nothing new
 *  (the species are known by then), so the file keeps every run's additions. */
export function mergeSpeciesFile(existing: string, ids: string[]): string {
  const all = new Set([...existing.split("\n").filter((l) => l.trim()), ...ids]);
  return [...all].join("\n") + "\n";
}

async function speciesStage(): Promise<Record<string, unknown>> {
  const { add } = await findMissingSpecies({ offline: true });
  const widened = widenedOnly(add);
  await insertMissingSpecies(widened, []);
  // By iNaturalist id, so species added by an earlier run are listed again too.
  const ids = (
    await pool.query<{ id: string }>(
      `SELECT id FROM species WHERE gbif_key < 0 AND inat_taxon_id = ANY($1::int[]) AND NOT is_other_taxa`,
      [widened.map((w) => w.inatTaxonId)],
    )
  ).rows.map((r) => r.id);
  mkdirSync(BUILD_DIR, { recursive: true });
  const file = mergeSpeciesFile(existsSync(SPECIES_FILE) ? readFileSync(SPECIES_FILE, "utf8") : "", ids);
  writeFileSync(SPECIES_FILE, file);
  const listed = file.split("\n").filter(Boolean).length;
  log(`species: ${widened.length} added; ${listed} widened species listed for the photo stage`);
  return { added: widened.length, listed };
}

function checklistsStage() {
  runScript("src/scripts/add-new-species-to-checklists.ts", ["--apply"]);
  runScript("src/scripts/build-country-checklists.ts", ["--apply"]);
  runScript("src/scripts/build-sea-zones-marine.ts", ["--offline", "--apply"]);
  runScript("src/scripts/build-country-marine-obis.ts", ["--apply"]);
  runScript("src/scripts/apply-inat-membership.ts", ["--apply", "--no-followups"], OFFLINE);
  runScript("src/scripts/remove-escapes.ts", ["--apply"]);
  runScript("src/scripts/apply-ebird-exotics.ts", ["--apply", "--max-requests=0"]);
  runScript("src/scripts/apply-introduced-flags.ts", ["--apply"], OFFLINE);
}

function photosStage() {
  checkDisk("the photo stage");
  // The gallery top-up's own pace: about 9,500 iNaturalist calls a day, under its 10,000.
  const paced = { INAT_API_INTERVAL_MS: "9100" };
  runScript("src/scripts/enrich-all-species.ts", [`--taxa=${MARINE_CLASSES}`, "--listed-only"], paced);
  checkDisk("the gallery top-up");
  try {
    execFileSync(
      "nice",
      [
        "-n",
        "19",
        "npx",
        "tsx",
        "src/scripts/top-up-galleries.ts",
        `--species-file=${SPECIES_FILE}`,
        `--min-free-gb=${MIN_FREE_GB}`,
      ],
      { cwd: PIPELINE_DIR, stdio: "inherit", env: { ...process.env, ...paced } },
    );
  } catch (err) {
    if ((err as { status?: number }).status === 3)
      throw new Error(`The gallery top-up stopped under ${MIN_FREE_GB} GB free; free space, then --resume`, {
        cause: err,
      });
    throw err;
  }
  runScript("src/scripts/backfill-photo-withheld.ts", ["--no-network"]);
}

async function dryRun(countries: string[] | null) {
  // Every query of this process and its children is read-only.
  process.env.PGOPTIONS = "-c default_transaction_read_only=on";
  const { add } = await findMissingSpecies({ offline: true });
  const widened = widenedOnly(add);
  const byTaxon = new Map(widened.map((w) => [w.inatTaxonId!, w]));
  const total = new Map<string, number>();
  for (const w of widened)
    total.set(`${w.taxonClass}\t${w.clade}`, (total.get(`${w.taxonClass}\t${w.clade}`) ?? 0) + 1);
  log(`${widened.length} species would be added (iNaturalist research grade somewhere, marine, visibility floor):`);
  for (const [k, n] of [...total].sort()) log(`  ${k.replace("\t", " / ").padEnd(40)} ${n}`);

  const rows = ["country\tgroup\tclade\tspecies"];
  const res = await pool.query<{ name: string; inat_place_id: number | null }>(
    `SELECT c.name, r.inat_place_id FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id ORDER BY c.name`,
  );
  const perCountry: Array<[string, number, Map<string, number>]> = [];
  for (const c of res.rows) {
    const counts = new Map<string, number>();
    for (const taxon of (c.inat_place_id != null ? cachedPlaceCounts(c.inat_place_id) : null)?.keys() ?? []) {
      const w = byTaxon.get(taxon);
      if (w) counts.set(`${w.taxonClass}\t${w.clade}`, (counts.get(`${w.taxonClass}\t${w.clade}`) ?? 0) + 1);
    }
    for (const [k, n] of counts) rows.push(`${c.name}\t${k}\t${n}`);
    perCountry.push([c.name, [...counts.values()].reduce((a, b) => a + b, 0), counts]);
  }
  mkdirSync(BUILD_DIR, { recursive: true });
  const tsv = path.join(BUILD_DIR, "marine-widening-dry-run.tsv");
  writeFileSync(tsv, rows.join("\n") + "\n");
  const shown = countries
    ? perCountry.filter(([n]) => countries.includes(n))
    : [...perCountry].sort((a, b) => b[1] - a[1]).slice(0, 15);
  log(countries ? "per country:" : "the 15 countries gaining most (all in the TSV):");
  for (const [name, n, counts] of shown)
    log(`  ${name}: +${n} (${[...counts].map(([k, v]) => `${k.split("\t")[1]} ${v}`).join(", ")})`);
  log(`per country and group: ${path.relative(PIPELINE_DIR, tsv)}`);
  // B on today's catalog, from the OBIS cache only (the new species are not in it yet).
  log("country OBIS rows on the current catalog (cached areas only):");
  runScript("src/scripts/build-country-marine-obis.ts", [
    "--offline",
    ...(countries ? [`--countries=${countries.join(",")}`] : []),
  ]);
  log("dry run, nothing written; rerun with --apply");
}

function takeLock(): void {
  try {
    mkdirSync(LOCK_DIR);
  } catch {
    const owner = path.join(LOCK_DIR, "owner");
    throw new Error(
      `The catalog write lock ${LOCK_DIR} is held${existsSync(owner) ? ` by ${readFileSync(owner, "utf8").trim()}` : ""}; ` +
        "wait for that writer, or remove the folder if it is stale",
    );
  }
  writeFileSync(path.join(LOCK_DIR, "owner"), `widen-marine-catalog pid ${process.pid}`);
}

export function parseStages(argv: string[]): Stage[] {
  const typed = argv
    .find((a) => a.startsWith("--stages="))
    ?.slice(9)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of typed ?? [])
    if (!STAGES.includes(s as Stage)) throw new Error(`Unknown stage "${s}"; stages are ${STAGES.join(", ")}`);
  return STAGES.filter((s) => !typed || typed.includes(s));
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const countries =
    argv
      .find((a) => a.startsWith("--countries="))
      ?.slice(12)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  try {
    if (!apply) return await dryRun(countries);
    const previous = existsSync(CURRENT_RUN)
      ? (JSON.parse(readFileSync(CURRENT_RUN, "utf8")) as { runId: string; stages: Stage[] })
      : null;
    const resume = argv.includes("--resume") && previous != null;
    const stages = resume ? previous.stages : parseStages(argv);
    const runId = resume ? previous.runId : randomUUID();
    checkTopUp(argv.includes("--ignore-top-up"));
    checkDisk("the run");
    takeLock();
    try {
      if (!resume) {
        await dumpDatabase(
          DATABASE_URL,
          path.join(BACKUP_DIR, `lifer-catalog-before-marine-widening-${snapshotStamp()}-tables.dump`),
          (m) => log(`backup: ${m}`),
          BACKUP_TABLES,
        );
        mkdirSync(BUILD_DIR, { recursive: true });
        writeFileSync(CURRENT_RUN, JSON.stringify({ runId, stages, startedAt: new Date().toISOString() }));
      }
      log(`run ${runId}: ${stages.join(", ")}`);
      for (const stage of stages) {
        const key = `marine:${stage}`;
        const done = await pool.query(
          `SELECT 1 FROM pipeline_runs WHERE run_id = $1 AND stage = $2 AND item = '' AND status = 'done'`,
          [runId, key],
        );
        if (done.rowCount) {
          log(`${stage}: done earlier in this run, skipped`);
          continue;
        }
        await pool.query(
          `INSERT INTO pipeline_runs (run_id, stage, status) VALUES ($1, $2, 'running')
           ON CONFLICT (run_id, stage, item) DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL`,
          [runId, key],
        );
        log(`${stage}: starting`);
        let notes: Record<string, unknown> = {};
        try {
          if (stage === "species") notes = await speciesStage();
          if (stage === "checklists") checklistsStage();
          if (stage === "audit") runScript("src/scripts/fix-catalog-audit.ts", ["--apply"]);
          if (stage === "tiers") await tiers(refreshArgs([]));
          if (stage === "photos") photosStage();
          if (stage === "vectors") await vectors({ occurrenceStats: false });
        } catch (err) {
          await pool.query(
            `UPDATE pipeline_runs SET status = 'failed', finished_at = now(), notes = $3 WHERE run_id = $1 AND stage = $2 AND item = ''`,
            [runId, key, JSON.stringify({ error: (err as Error).message })],
          );
          throw err;
        }
        await pool.query(
          `UPDATE pipeline_runs SET status = 'done', finished_at = now(), notes = $3 WHERE run_id = $1 AND stage = $2 AND item = ''`,
          [runId, key, JSON.stringify(notes)],
        );
      }
      log(`run ${runId} finished; next: npm run refresh -w data-pipeline -- --stages=packs,gate`);
    } finally {
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[widen-marine] ${(err as Error).message}`);
    process.exit(1);
  });
}
