// Checks that this machine can run the data pipeline, and prints a pass/fail list. Read-only: it
// never writes to the database (its session is READ ONLY), the disk or GitHub.
//
//   npm run doctor -w data-pipeline               everything a refresh needs
//   npm run doctor -w data-pipeline -- --publish  also what refresh --publish needs (gh, pg_dump)
//
// Reads the same environment as the refresh (the repo-root .env, then the shell, which wins).
// Exits 1 when a check fails. The rules are in pipeline/doctorChecks.ts; what to do about each one
// is in docs/docs/contributing/rebuilding-data.md.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statfsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { GITHUB_REPO } from "../build/release-groups.js";
import {
  checkDataReleaseFlags,
  checkDisk,
  checkEnv,
  checkMemory,
  checkMigrations,
  checkNodeVersion,
  checkPgDump,
  checkPlatform,
  checkPostgis,
  checkShm,
  formatBytes,
  formatReport,
  GIB,
  parsePgDumpMajor,
  redactDatabaseUrl,
  type CacheBudget,
  type CheckResult,
  type ReleaseFlags,
} from "../pipeline/doctorChecks.js";
import { resolvePgDump } from "../pipeline/pgDump.js";

const PIPELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.join(PIPELINE_DIR, "..", "..");
const DATA = path.join(PIPELINE_DIR, "data");
const MIGRATIONS_DIR = path.join(PIPELINE_DIR, "migrations");
const VENV_PYTHON = path.join(PIPELINE_DIR, ".venv", "bin", "python");

/** stdout of a command, or null when it's missing or fails. */
function run(cmd: string, args: string[], timeoutMs = 30_000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).trim();
  } catch {
    return null;
  }
}

/** Bytes under a folder, with du (read-only), or 0 when it doesn't exist. */
function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  const out = run("du", ["-sk", dir], 15 * 60_000);
  return out ? Number(out.split(/\s/)[0]) * 1024 : 0;
}

function nearestExisting(p: string): string {
  let dir = path.resolve(p);
  while (!existsSync(dir)) dir = path.dirname(dir);
  return dir;
}

async function databaseChecks(
  url: string | undefined,
): Promise<{ results: CheckResult[]; serverMajor: number | null }> {
  if (!url)
    return { results: [{ name: "Database", status: "skip", detail: "DATABASE_URL isn't set" }], serverMajor: null };
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  const results: CheckResult[] = [];
  try {
    await client.connect();
  } catch (err) {
    return {
      results: [
        {
          name: "Database",
          status: "fail",
          detail: `can't connect to ${redactDatabaseUrl(url)}: ${(err as Error).message}`,
          fix: "start Postgres (see the docs) and check DATABASE_URL",
        },
      ],
      serverMajor: null,
    };
  }
  try {
    // Every statement below only reads; this makes sure of it.
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const version = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0].v;
    const serverMajor = Number(version.split(".")[0]) || null;
    results.push({ name: "Database", status: "pass", detail: `${redactDatabaseUrl(url)}, Postgres ${version}` });

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const hasTable = (await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`)).rows[0]
      .ok as boolean;
    const applied = hasTable
      ? (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename)
      : null;
    results.push(checkMigrations(files, applied));

    const ext = await client.query<{ installed: boolean; available: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS installed,
              EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') AS available`,
    );
    results.push(checkPostgis(ext.rows[0].installed, ext.rows[0].available));

    if (hasTable && (await client.query(`SELECT to_regclass('public.species') IS NOT NULL AS ok`)).rows[0].ok) {
      const counts = (
        await client.query<{ species: string; listed: string; with_file: string }>(
          `SELECT (SELECT count(*) FROM species) AS species,
                  (SELECT count(DISTINCT species_id) FROM region_species) AS listed,
                  (SELECT count(*) FROM species WHERE reference_display_path IS NOT NULL) AS with_file`,
        )
      ).rows[0];
      const species = Number(counts.species);
      results.push(
        species === 0
          ? {
              name: "Catalog",
              status: "warn",
              detail: "empty",
              fix: "bootstrap it first (rebuilding-data.md, Bootstrap an empty database)",
            }
          : {
              name: "Catalog",
              status: "pass",
              detail: `${species} species, ${counts.listed} on a checklist, ${counts.with_file} with a photo file on disk`,
            },
      );
    }
    return { results, serverMajor };
  } finally {
    await client.end();
  }
}

/** The Docker container publishing DATABASE_URL's port, and its /dev/shm size. */
function shmCheck(url: string | undefined): CheckResult {
  let container = process.env.LIFER_POSTGRES_CONTAINER || null;
  if (!container && url) {
    let port = "5432";
    try {
      port = new URL(url).port || "5432";
    } catch {
      // checkEnv reports a bad URL
    }
    const ps = run("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
    container =
      ps
        ?.split("\n")
        .find((line) => line.includes(`:${port}->5432/tcp`))
        ?.split("\t")[0] ?? null;
  }
  const shm = container ? run("docker", ["inspect", "-f", "{{.HostConfig.ShmSize}}", container]) : null;
  return checkShm(shm ? Number(shm) : null, container);
}

function pythonCheck(): CheckResult[] {
  const name = "Python environment";
  const setup =
    "python3 -m venv packages/data-pipeline/.venv && packages/data-pipeline/.venv/bin/pip install -r packages/data-pipeline/python/requirements.txt";
  if (!existsSync(VENV_PYTHON))
    return [
      {
        name,
        status: "fail",
        detail: "packages/data-pipeline/.venv is missing (the vectors stage needs it)",
        fix: setup,
      },
    ];
  const out = run(
    VENV_PYTHON,
    [
      "-c",
      "import sys, torch, open_clip, psycopg2, PIL, onnx, onnxruntime; print(sys.version.split()[0], 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')",
    ],
    180_000,
  );
  if (!out) return [{ name, status: "fail", detail: "the venv exists but its packages don't import", fix: setup }];
  const [version, device] = out.split(" ");
  return [
    {
      name,
      status: "pass",
      detail: `Python ${version}, torch, open_clip, psycopg2, pillow, onnx and onnxruntime import`,
    },
    device === "cpu"
      ? {
          name: "GPU for the identification model",
          status: "warn",
          detail: "none (CPU only)",
          fix: "expect the vectors stage to take many hours; an Apple Silicon or CUDA GPU is much faster",
        }
      : { name: "GPU for the identification model", status: "pass", detail: device },
  ];
}

function cacheChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  const zipDir = path.join(DATA, "gbif-country-cache");
  const zips = existsSync(zipDir) ? readdirSync(zipDir).filter((f) => f.endsWith(".zip")).length : 0;
  // Budgets: about what each holds after a full run (the maintainer's, October 2026, plus room).
  const caches: Array<CacheBudget & { dir: string; note: string }> = [
    { name: "GBIF country downloads", dir: zipDir, budget: 70 * GIB, present: 0, note: `${zips} country files` },
    {
      name: "province aggregates",
      dir: path.join(DATA, "province-aggregate-cache"),
      budget: 110 * GIB,
      present: 0,
      note: "rebuilt from the country files",
    },
    {
      name: "pipeline build output",
      dir: path.join(DATA, "build"),
      budget: 15 * GIB,
      present: 0,
      note: "photo store, packs, catalog seed",
    },
    {
      name: "iNaturalist counts",
      dir: path.join(DATA, "inat-species-counts-cache"),
      budget: 0.5 * GIB,
      present: 0,
      note: "photo counts per place",
    },
    {
      name: "eBird lists",
      dir: path.join(DATA, "ebird-spplist-cache"),
      budget: 0.1 * GIB,
      present: 0,
      note: "region species lists",
    },
    {
      name: "raw source downloads",
      dir: path.join(REPO_ROOT, "data", "raw"),
      budget: 1 * GIB,
      present: 0,
      note: "trait tables, sea areas, boundaries",
    },
    {
      name: "reference photos",
      dir: path.join(APP_DATA_DIR, "reference-display"),
      budget: 7 * GIB,
      present: 0,
      note: `display size, in ${APP_DATA_DIR}`,
    },
    {
      name: "reference thumbnails",
      dir: path.join(APP_DATA_DIR, "reference-thumb"),
      budget: 4.5 * GIB,
      present: 0,
      note: "thumbnail size",
    },
  ];
  console.log("[doctor] measuring caches with du (the big ones can take a minute)");
  for (const c of caches) {
    c.present = folderBytes(c.dir);
    const where = path.relative(REPO_ROOT, c.dir).startsWith("..") ? c.dir : path.relative(REPO_ROOT, c.dir);
    results.push(
      c.present > 0
        ? { name: `Cache: ${c.name}`, status: "pass", detail: `${formatBytes(c.present)} in ${where} (${c.note})` }
        : {
            name: `Cache: ${c.name}`,
            status: "warn",
            detail: `empty or missing: ${where}`,
            fix: "the refresh fills it; budget the time and disk in the docs",
          },
    );
  }
  // One check per disk, since the photos can live elsewhere (APP_DATA_DIR).
  const byDevice = new Map<number, { dir: string; caches: CacheBudget[] }>();
  for (const c of caches) {
    const existing = nearestExisting(c.dir);
    const dev = statSync(existing).dev;
    if (!byDevice.has(dev)) byDevice.set(dev, { dir: existing, caches: [] });
    byDevice.get(dev)!.caches.push(c);
  }
  for (const { dir, caches: onDisk } of byDevice.values()) {
    const fs = statfsSync(dir);
    const label = path.relative(REPO_ROOT, dir).startsWith("..") ? dir : path.relative(REPO_ROOT, dir);
    results.push(checkDisk(`disk holding ${label}`, fs.bavail * fs.bsize, onDisk));
  }
  return results;
}

function toolChecks(serverMajor: number | null, publish: boolean): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(
    run("unzip", ["-v"])
      ? { name: "unzip", status: "pass", detail: "on PATH" }
      : { name: "unzip", status: "fail", detail: "not found (reads the GBIF country files)", fix: "install unzip" },
  );
  // The same pg_dump build-catalog-seed.ts would pick (pipeline/pgDump.ts).
  const pgDump = resolvePgDump(process.env.DATABASE_URL ?? "postgres://lifer:lifer@localhost:5432/lifer");
  const dumpVersion = run(pgDump.command, [...pgDump.prefixArgs, "--version"]);
  const pgDumpResult = checkPgDump(dumpVersion ? parsePgDumpMajor(dumpVersion) : null, serverMajor, publish);
  const shown = [pgDump.command, ...pgDump.prefixArgs].join(" ");
  results.push({ ...pgDumpResult, detail: `${pgDumpResult.detail} (${shown}, from ${pgDump.source})` });

  const ghName = "GitHub CLI (gh)";
  const missing = publish ? "fail" : "warn";
  if (!run("gh", ["--version"])) {
    results.push({
      name: ghName,
      status: missing,
      detail: "not found; refresh --publish uploads with it",
      fix: "install gh and run gh auth login",
    });
    return results;
  }
  if (run("gh", ["auth", "status"]) == null) {
    results.push({
      name: ghName,
      status: missing,
      detail: "not signed in",
      fix: "gh auth login (with the repo scope)",
    });
    return results;
  }
  results.push({ name: ghName, status: "pass", detail: "signed in" });
  // gh uploads to the repo it resolves from this checkout; pack and photo URLs use GITHUB_REPO.
  const target = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (!target) {
    results.push({
      name: "Publish target",
      status: missing,
      detail: "gh can't tell which repository this checkout publishes to",
      fix: "gh repo set-default <owner>/lifer-app",
    });
    return results;
  }
  results.push(
    target === GITHUB_REPO
      ? {
          name: "Publish target",
          status: "pass",
          detail: `gh publishes to ${target}, the repo pack and photo URLs point at`,
        }
      : {
          name: "Publish target",
          status: missing,
          detail: `gh publishes to ${target}, but GITHUB_REPO in src/build/release-groups.ts is ${GITHUB_REPO}`,
          fix: "set GITHUB_REPO to your fork, or gh repo set-default to the repo you mean",
        },
  );
  results.push(
    run("gh", ["release", "view", "catalog-latest", "--repo", target, "--json", "tagName"])
      ? { name: "Release catalog-latest", status: "pass", detail: `exists on ${target}` }
      : {
          name: "Release catalog-latest",
          status: missing,
          detail: `missing on ${target}; refresh --publish uploads to it but doesn't create it`,
          fix: 'gh release create catalog-latest --title "Catalog (latest)" --notes "Species catalog seed." --prerelease --latest=false',
        },
  );
  const releases = run("gh", [
    "release",
    "list",
    "--repo",
    target,
    "--limit",
    "200",
    "--json",
    "tagName,isPrerelease,isLatest",
  ]);
  results.push(checkDataReleaseFlags(releases == null ? null : (JSON.parse(releases) as ReleaseFlags[])));
  return results;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const url = process.env.DATABASE_URL?.trim() || undefined;
  const results: CheckResult[] = [
    checkPlatform(process.platform),
    checkNodeVersion(process.version),
    checkMemory(os.totalmem()),
  ];
  results.push(...checkEnv(process.env, { publish }));
  const db = await databaseChecks(url);
  results.push(...db.results);
  results.push(shmCheck(url));
  results.push(...pythonCheck());
  results.push(...toolChecks(db.serverMajor, publish));
  results.push(...cacheChecks());
  const { text, exitCode } = formatReport(results);
  console.log(`\nData pipeline doctor${publish ? " (with --publish)" : ""}\n`);
  console.log(text);
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(`[doctor] ${(err as Error).message}`);
  process.exit(1);
});
