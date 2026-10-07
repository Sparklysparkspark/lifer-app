// Which pg_dump the catalog seed is dumped with (build-catalog-seed.ts, refresh.ts, doctor.ts).
// Installs restore the seed into Postgres 18, so the dump should come from pg_dump 18. In order:
//
//   1. PG_DUMP_BIN, when set.
//   2. A desktop app build's PostgreSQL, which ships pg_dump: LIFER_POSTGRES_DIR (the
//      build-postgres-macos.sh output a desktop build bundles), then the one prepare-resources
//      staged in this checkout, then an installed macOS app's.
//   3. `docker exec <container> pg_dump`, when DATABASE_URL points at a local port a running
//      Docker container publishes from its 5432 (the pipeline's docker-compose Postgres). The
//      container's own pg_dump matches its server, and it connects to the container's port.
//   4. pg_dump on PATH.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";

export interface PgDumpCommand {
  /** The program to run. */
  command: string;
  /** Arguments before pg_dump's own (`exec -i <container> pg_dump` for Docker). */
  prefixArgs: string[];
  /** Where it came from, for logs and the doctor. */
  source: string;
  /** The connection URL pg_dump should use (rewritten to the container's port for Docker). */
  databaseUrl: string;
}

export interface PgDumpInputs {
  env: Record<string, string | undefined>;
  databaseUrl: string;
  exists: (file: string) => boolean;
  /** `docker ps` rows as "<name>\t<ports>", or null when Docker isn't available. */
  dockerContainers: () => string[] | null;
  /** Desktop app folders holding a bundled PostgreSQL's bin/, most specific first. */
  bundledDirs: string[];
}

/** The desktop builds' PostgreSQL folders this checkout and machine might have. */
export function defaultBundledDirs(env: Record<string, string | undefined> = process.env): string[] {
  const dirs = [path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "resources-staging", "postgres")];
  if (env.LIFER_POSTGRES_DIR?.trim()) dirs.unshift(env.LIFER_POSTGRES_DIR.trim());
  if (process.platform === "darwin") dirs.push("/Applications/Lifer.app/Contents/Resources/postgres");
  return dirs;
}

/** The container publishing `port` on this machine from its Postgres port 5432, if any. */
export function dockerContainerForPort(rows: string[], port: string): string | null {
  for (const row of rows) {
    const [name, ports = ""] = row.split("\t");
    // e.g. "0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp"
    for (const mapping of ports.split(",")) {
      const m = /:(\d+)->5432\/tcp/.exec(mapping.trim());
      if (m && m[1] === port) return name.trim();
    }
  }
  return null;
}

function isLocalHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}

export function choosePgDump(inputs: PgDumpInputs): PgDumpCommand {
  const { env, databaseUrl } = inputs;
  const explicit = env.PG_DUMP_BIN?.trim();
  if (explicit) return { command: explicit, prefixArgs: [], source: "PG_DUMP_BIN", databaseUrl };

  for (const dir of inputs.bundledDirs) {
    const bin = path.join(dir, "bin", `pg_dump${EXE}`);
    if (inputs.exists(bin)) return { command: bin, prefixArgs: [], source: "desktop build", databaseUrl };
  }

  let url: URL | null = null;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL (a libpq keyword string): Docker detection doesn't apply.
  }
  if (url && isLocalHost(url.hostname)) {
    const port = url.port || "5432";
    const rows = inputs.dockerContainers();
    const container = rows ? dockerContainerForPort(rows, port) : null;
    if (container) {
      const inside = new URL(url.href);
      inside.hostname = "localhost";
      inside.port = "5432";
      return {
        command: "docker",
        prefixArgs: ["exec", "-i", container, "pg_dump"],
        source: `Docker container ${container}`,
        databaseUrl: inside.href,
      };
    }
  }

  return { command: `pg_dump${EXE}`, prefixArgs: [], source: "PATH", databaseUrl };
}

function listDockerContainers(): string[] | null {
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** The pg_dump to use for `databaseUrl` on this machine (see the order at the top). */
export function resolvePgDump(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): PgDumpCommand {
  return choosePgDump({
    env,
    databaseUrl,
    exists: existsSync,
    dockerContainers: listDockerContainers,
    bundledDirs: defaultBundledDirs(env),
  });
}
