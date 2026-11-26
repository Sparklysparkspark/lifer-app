// A pg_dump -Fc of the whole database into data/backups/, taken by refresh before it changes
// anything and by scripts/backup.ts. pg_dump is the one pgDump.ts picks, so with no matching local
// install it runs inside the Docker container serving DATABASE_URL.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { resolvePgDump } from "./pgDump.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const BACKUP_DIR = process.env.LIFER_BACKUP_DIR ?? path.join(REPO_ROOT, "data", "backups");

export const snapshotStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

/** Dumps `databaseUrl` (only `tables`, when given) to `outFile`. Written to a .partial file first, so a dump that dies never
 *  looks like a finished one. */
export async function dumpDatabase(
  databaseUrl: string,
  outFile: string,
  log = console.log,
  tables: string[] = [],
): Promise<void> {
  const cmd = resolvePgDump(databaseUrl);
  log(`pg_dump ${cmd.source} -> ${outFile}`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const partial = `${outFile}.partial`;
  const only = tables.flatMap((t) => ["-t", t]);
  const child = spawn(cmd.command, [...cmd.prefixArgs, "-Fc", ...only, cmd.databaseUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  // Registered before awaiting the copy, so an early "close" isn't missed.
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  try {
    await pipeline(child.stdout, createWriteStream(partial));
    const code = await exit;
    if (code !== 0) throw new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`);
    if (statSync(partial).size === 0) throw new Error("pg_dump wrote nothing");
    renameSync(partial, outFile);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

/** The newest finished database dump in BACKUP_DIR, if any. */
export function newestSnapshot(dir = BACKUP_DIR): { file: string; at: Date } | null {
  if (!existsSync(dir)) return null;
  let best: { file: string; at: Date } | null = null;
  for (const f of readdirSync(dir)) {
    if (!/^lifer-db-.*\.(dump|sql)$/.test(f)) continue;
    const at = statSync(path.join(dir, f)).mtime;
    if (!best || at > best.at) best = { file: f, at };
  }
  return best;
}
