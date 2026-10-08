// The pure half of `npm run doctor -w data-pipeline` (scripts/doctor.ts): the rules for what a
// data pipeline machine needs, and how the results print. No I/O here, so each rule is tested on
// its own (doctorChecks.test.ts). docs/docs/contributing/rebuilding-data.md explains each check.

export type Status = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

const LABEL: Record<Status, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

/** The report as printed, and the exit code: 1 when anything failed, 0 otherwise. */
export function formatReport(results: CheckResult[]): { text: string; exitCode: number } {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${LABEL[r.status]}  ${r.name}: ${r.detail}`);
    if (r.fix && (r.status === "warn" || r.status === "fail")) lines.push(`      fix: ${r.fix}`);
  }
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  lines.push("");
  lines.push(`${count("pass")} passed, ${count("warn")} warning(s), ${count("fail")} failed, ${count("skip")} skipped`);
  return { text: lines.join("\n"), exitCode: count("fail") > 0 ? 1 : 0 };
}

export const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// ---------- environment variables ----------

export interface EnvRule {
  name: string;
  /** required: the refresh fails without it. recommended: it runs, with worse data. optional: has a default. */
  need: "required" | "recommended" | "optional";
  /** Never print the value, only whether it's set. */
  secret: boolean;
  purpose: string;
  /** An error message for a value that's set but wrong, or null. */
  validate?: (value: string) => string | null;
  /** A warning for a value that's valid but risky, or null. */
  caution?: (value: string, opts: { publish: boolean }) => string | null;
}

const flagOnly = (value: string) => (value === "1" ? null : 'only "1" turns it on');
const positiveNumber = (value: string) => (Number(value) > 0 ? null : "must be a positive number");

// Everything packages/data-pipeline and packages/core read that matters to a pipeline run. The
// server's own variables (PORT, SINGLE_USER_MODE, ...) aren't listed: a refresh never reads them.
export const ENV_RULES: EnvRule[] = [
  {
    name: "DATABASE_URL",
    need: "required",
    secret: true,
    purpose: "the pipeline database (Postgres with PostGIS)",
    validate: (v) => (/^postgres(ql)?:\/\//.test(v) ? null : "must start with postgres:// or postgresql://"),
  },
  {
    name: "GBIF_USER",
    need: "required",
    secret: true,
    purpose: "GBIF.org account, for the country occurrence downloads",
  },
  { name: "GBIF_PWD", need: "required", secret: true, purpose: "GBIF.org password" },
  {
    name: "EBIRD_API_KEY",
    need: "recommended",
    secret: true,
    purpose: "eBird's region species lists; without it province bird lists get no eBird rescue",
  },
  {
    name: "PG_DUMP_BIN",
    need: "optional",
    secret: false,
    purpose:
      "pg_dump for the catalog seed (default: a desktop build's bundled one, else the Docker container's behind DATABASE_URL, else pg_dump on PATH)",
  },
  {
    name: "APP_DATA_DIR",
    need: "optional",
    secret: false,
    purpose: "where reference photos are stored (default: DATA_DIR, else data/lifer-app-data)",
  },
  { name: "DATA_DIR", need: "optional", secret: false, purpose: "the app's library folder (default: data/lifer)" },
  {
    name: "LIFER_INAT_CACHE_MAX_AGE_DAYS",
    need: "optional",
    secret: false,
    purpose: "how long cached iNaturalist lists are reused (default 90)",
    validate: positiveNumber,
  },
  {
    name: "LIFER_INAT_OFFLINE",
    need: "optional",
    secret: false,
    purpose: "1 answers iNaturalist questions from the caches only",
    validate: flagOnly,
  },
  {
    name: "PHOTO_STORE_FROM_SCRATCH",
    need: "optional",
    secret: false,
    purpose: "1 rewrites every photo store shard instead of reusing published ones",
    validate: flagOnly,
  },
  {
    name: "PACK_CONCURRENCY",
    need: "optional",
    secret: false,
    purpose: "packs built at once (default 6)",
    validate: positiveNumber,
  },
  {
    name: "LIFER_ALLOW_NONCOMMERCIAL_PHOTOS",
    need: "optional",
    secret: false,
    purpose: "local development only: widens the photo fetchers",
    caution: (v) => (v ? "local development only; unset it for a run you will publish" : null),
  },
  {
    name: "ALLOW_MISSING_PHOTOS",
    need: "optional",
    secret: false,
    purpose: "1 lets a pack build past missing photo files",
    caution: (v, { publish }) =>
      v === "1" && publish ? "packs may ship without photos; unset it before publishing" : null,
  },
];

/** One result per rule. Secret values are never part of the output. */
export function checkEnv(
  env: Record<string, string | undefined>,
  opts: { publish: boolean },
  rules: EnvRule[] = ENV_RULES,
): CheckResult[] {
  return rules.map((rule) => {
    const name = `env ${rule.name}`;
    const value = env[rule.name]?.trim() ?? "";
    if (!value) {
      if (rule.need === "required")
        return {
          name,
          status: "fail",
          detail: `not set (${rule.purpose})`,
          fix: `set ${rule.name} in the repo-root .env or the shell`,
        };
      if (rule.need === "recommended")
        return {
          name,
          status: "warn",
          detail: `not set (${rule.purpose})`,
          fix: `set ${rule.name} in the repo-root .env`,
        };
      return { name, status: "pass", detail: `not set: ${rule.purpose}` };
    }
    const shown = rule.secret ? "set" : `set to ${value}`;
    const invalid = rule.validate?.(value);
    if (invalid) return { name, status: "fail", detail: `${shown}, but ${invalid}`, fix: `fix ${rule.name}` };
    const caution = rule.caution?.(value, opts);
    if (caution) return { name, status: "warn", detail: `${shown}: ${caution}`, fix: `unset ${rule.name}` };
    return { name, status: "pass", detail: shown };
  });
}

/** postgres://user:secret@host:5432/db -> postgres://user:***@host:5432/db */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(not a valid URL)";
  }
}

// ---------- tools and machine ----------

export const MIN_NODE_MAJOR = 22;

export function checkNodeVersion(version: string, minMajor = MIN_NODE_MAJOR): CheckResult {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  if (!major) return { name: "Node.js", status: "fail", detail: `couldn't read the version "${version}"` };
  if (major < minMajor)
    return {
      name: "Node.js",
      status: "fail",
      detail: `${version}, needs ${minMajor} or newer`,
      fix: "install Node 22 (the repo's .nvmrc)",
    };
  return { name: "Node.js", status: "pass", detail: version };
}

/** "pg_dump (PostgreSQL) 18.6" -> 18 */
export function parsePgDumpMajor(output: string): number | null {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(output);
  return m ? Number(m[1]) : null;
}

// Installs (desktop and Docker) restore the seed into Postgres 18.
export const INSTALL_PG_MAJOR = 18;

export function checkPgDump(pgDumpMajor: number | null, serverMajor: number | null, publish: boolean): CheckResult {
  const name = "pg_dump for the catalog seed";
  const missing: Status = publish ? "fail" : "warn";
  if (pgDumpMajor == null)
    return {
      name,
      status: missing,
      detail: "not found",
      fix: "install the Postgres 18 client tools, or set PG_DUMP_BIN",
    };
  if (serverMajor != null && pgDumpMajor < serverMajor) {
    return {
      name,
      status: missing,
      detail: `pg_dump ${pgDumpMajor} can't dump a Postgres ${serverMajor} server`,
      fix: `use pg_dump ${Math.max(serverMajor, INSTALL_PG_MAJOR)} (PG_DUMP_BIN)`,
    };
  }
  if (pgDumpMajor !== INSTALL_PG_MAJOR) {
    return {
      name,
      status: "warn",
      detail: `pg_dump ${pgDumpMajor}; installs restore into Postgres ${INSTALL_PG_MAJOR}`,
      fix: `use pg_dump ${INSTALL_PG_MAJOR} (PG_DUMP_BIN)`,
    };
  }
  return { name, status: "pass", detail: `pg_dump ${pgDumpMajor}` };
}

// docker-compose.yml gives Postgres 256 MB; Docker's default 64 MB makes big parallel queries
// fail with "could not resize shared memory segment".
export const MIN_SHM_BYTES = 256 * MIB;

export function checkShm(bytes: number | null, container: string | null): CheckResult {
  const name = "Postgres shared memory (/dev/shm)";
  if (bytes == null || container == null) {
    return {
      name,
      status: "skip",
      detail: "Postgres isn't in a Docker container this can see; give it at least 256 MB of /dev/shm if it is",
    };
  }
  if (bytes < MIN_SHM_BYTES) {
    return {
      name,
      status: "warn",
      detail: `${formatBytes(bytes)} in container ${container}`,
      fix: "recreate it with --shm-size=256m, or use the compose files (shm_size: 256mb)",
    };
  }
  return { name, status: "pass", detail: `${formatBytes(bytes)} in container ${container}` };
}

// The maintainer's runs use a 24 GB machine. refresh-all-provinces.ts gives each country up to 16 GB
// of heap, and Postgres runs alongside.
export const RECOMMENDED_RAM_BYTES = 24 * GIB;
export function checkMemory(totalBytes: number): CheckResult {
  const detail = `${formatBytes(totalBytes)} of RAM`;
  if (totalBytes < RECOMMENDED_RAM_BYTES - GIB) {
    return {
      name: "Memory",
      status: "warn",
      detail: `${detail}; 24 GB or more recommended (the province stage uses up to 16 GB of heap)`,
      fix: "use a bigger machine, or expect big countries to run out of memory",
    };
  }
  return { name: "Memory", status: "pass", detail };
}

export function checkPlatform(platform: string): CheckResult {
  if (platform === "darwin" || platform === "linux")
    return { name: "Operating system", status: "pass", detail: platform };
  return {
    name: "Operating system",
    status: "warn",
    detail: `${platform}: the pipeline is only run on macOS and Linux`,
    fix: "use WSL 2 or a Linux machine",
  };
}

// ---------- database ----------

export function checkMigrations(files: string[], applied: string[] | null): CheckResult {
  const name = "Migrations";
  if (applied == null)
    return {
      name,
      status: "fail",
      detail: "no schema_migrations table: the database was never migrated",
      fix: "npm run migrate -w data-pipeline",
    };
  const done = new Set(applied);
  const pending = files.filter((f) => !done.has(f));
  if (pending.length > 0) {
    return {
      name,
      status: "fail",
      detail: `${pending.length} pending (first: ${pending[0]})`,
      fix: "npm run migrate -w data-pipeline",
    };
  }
  return { name, status: "pass", detail: `all ${files.length} applied` };
}

export function checkPostgis(installed: boolean, available: boolean): CheckResult {
  const name = "PostGIS extension";
  if (installed) return { name, status: "pass", detail: "installed" };
  if (available)
    return {
      name,
      status: "fail",
      detail: "available but not created",
      fix: "run CREATE EXTENSION postgis; in the database",
    };
  return {
    name,
    status: "fail",
    detail: "not available in this Postgres",
    fix: "use the dev image (docker/docker-compose.dev.yml, imresamu/postgis:18-3.6-alpine)",
  };
}

// ---------- data releases ----------

/** The GitHub releases that aren't app releases: the data, which installs and the pipeline find by
 *  these tags, and the source of bundled third-party libraries. */
export const DATA_RELEASE_TAGS = [
  "catalog-latest",
  "packs-latest",
  "photos-latest",
  "map-latest",
  "models",
  "third-party-sources",
];

export interface ReleaseFlags {
  tagName: string;
  isPrerelease: boolean;
  isLatest: boolean;
}

/** Every data release must be a prerelease and never "Latest": the desktop updater and the web
 *  app's update banner read the repository's latest release, and app downloads list it first. */
export function checkDataReleaseFlags(releases: ReleaseFlags[] | null): CheckResult {
  const name = "Data releases are prereleases";
  if (releases == null) return { name, status: "skip", detail: "couldn't list releases with gh" };
  const wrong = releases.filter((r) => DATA_RELEASE_TAGS.includes(r.tagName) && (!r.isPrerelease || r.isLatest));
  if (wrong.length === 0) return { name, status: "pass", detail: "none is a full release or marked Latest" };
  return {
    name,
    status: "fail",
    detail: `not a prerelease, or marked Latest: ${wrong.map((r) => r.tagName).join(", ")}`,
    fix: wrong.map((r) => `gh release edit ${r.tagName} --prerelease --latest=false`).join("; "),
  };
}

// ---------- disk ----------

export interface CacheBudget {
  name: string;
  /** About what a full rebuild holds here. */
  budget: number;
  /** What's there now (0 when missing). */
  present: number;
}

/** Free space on one disk against what its caches still need to grow by, plus 10% headroom. */
export function checkDisk(label: string, free: number, caches: CacheBudget[]): CheckResult {
  const needed = Math.round(caches.reduce((sum, c) => sum + Math.max(0, c.budget - c.present), 0) * 1.1);
  const name = `Free disk (${label})`;
  const detail = `${formatBytes(free)} free, about ${formatBytes(needed)} still needed for ${caches.map((c) => c.name).join(", ")}`;
  if (free < needed)
    return { name, status: "fail", detail, fix: "free space or move the data folder to a bigger disk" };
  return { name, status: "pass", detail };
}
