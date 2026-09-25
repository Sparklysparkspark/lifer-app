// Rebuilds already-published packs and keeps only the ones whose content actually changed, ready
// for build-pack-index.ts + publish-packs.ts. Closes the gap SCRIPTS.md describes under
// "Refreshing an already-published region": build-and-publish-all-packs.ts skips anything the
// published index already lists, so data fixes (restored photos, recomputed vectors, removed
// maps) never reached packs that were already out.
//
// Each published pack is rebuilt from the current database into a scratch folder and its
// manifest's contentVersion compared with the published one; a changed pack is moved into
// <outDir>, an unchanged one is discarded. contentVersion hashes the manifest, which records
// every photo file a pack ships and every vector, so a pack that was missing photos or carried
// old-model vectors reads as changed once the database has them.
//
// Usage:
//   npx tsx src/scripts/rebuild-changed-packs.ts <outDir> [--species-file=names.txt] [--ids-file=ids.txt] [--concurrency=4] [--limit=N]
// then:
//   npx tsx src/build/build-pack-index.ts <outDir>
//   npx tsx src/scripts/publish-packs.ts <outDir>
// --species-file limits the rebuild to packs listing any of those scientific names (one per line);
// --ids-file to those pack ids. Every run writes <outDir>/rebuild-report.json (which ids changed,
// were unchanged, produced no archive, or failed and why), so a partial run can be retried with
// --ids-file.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { mapWithConcurrency } from "../concurrency.js";
import { regionPackFileName, seaZonePackFileName, type PackVariant } from "../build/pack-id.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.join(__dirname, "..", "..");
const INDEX_URL =
  process.env.PACK_INDEX_URL ?? "https://github.com/Sparklysparkspark/lifer-app/releases/download/packs-latest/pack-index.json";

interface IndexEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  variant?: PackVariant;
  contentVersion: string;
  scientificNames?: string[];
}

function builtContentVersion(archive: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-rebuild-"));
  try {
    tar.extract({ file: archive, cwd: dir, sync: true, filter: (p) => p === "manifest.json" });
    return (JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { contentVersion: string }).contentVersion;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith("--"));
  if (!outDir) {
    console.error("Usage: rebuild-changed-packs.ts <outDir> [--species-file=names.txt] [--concurrency=4] [--limit=N]");
    process.exit(1);
  }
  const speciesFile = args.find((a) => a.startsWith("--species-file="))?.split("=")[1];
  const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 4);
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
  mkdirSync(outDir, { recursive: true });

  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`Couldn't fetch the published pack index: HTTP ${res.status}`);
  let entries = ((await res.json()) as { packs: IndexEntry[] }).packs;
  if (speciesFile) {
    const names = new Set(readFileSync(speciesFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    entries = entries.filter((e) => (e.scientificNames ?? []).some((n) => names.has(n)));
  }
  const idsFile = args.find((a) => a.startsWith("--ids-file="))?.split("=")[1];
  if (idsFile) {
    const ids = new Set(readFileSync(idsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    entries = entries.filter((e) => ids.has(e.id));
  }
  entries = entries.slice(0, limit);
  console.log(`[rebuild-changed-packs] rebuilding ${entries.length} published pack(s), ${concurrency} at a time`);

  const report: Record<"changed" | "unchanged" | "notBuilt", string[]> & { failed: Array<{ id: string; error: string }> } = {
    changed: [],
    unchanged: [],
    notBuilt: [],
    failed: [],
  };
  let changed = 0;
  let unchanged = 0;
  let notBuilt = 0;
  const failures: string[] = [];
  let done = 0;
  await mapWithConcurrency(entries, concurrency, async (e) => {
    const variant = e.variant ?? "full";
    const work = mkdtempSync(path.join(os.tmpdir(), "lifer-rebuild-out-"));
    try {
      const name = (e.type === "seaZone" ? e.seaZone : e.region)!;
      const fileName = e.type === "seaZone" ? seaZonePackFileName(name, e.taxon ?? null, variant) : regionPackFileName(name, e.taxon ?? null, variant);
      const cli = ["tsx", "src/build/build-region-pack.ts", ...(e.type === "seaZone" ? ["--sea-zone"] : []), name, work, `--variant=${variant}`];
      if (e.taxon) cli.push(`--taxon=${e.taxon}`);
      await execFileAsync("npx", cli, { cwd: PIPELINE_DIR, maxBuffer: 64 * 1024 * 1024 });
      const archive = path.join(work, fileName);
      if (!existsSync(archive)) {
        notBuilt++; // e.g. the checklist for that taxon is empty now
        report.notBuilt.push(e.id);
      } else if (builtContentVersion(archive) === e.contentVersion) {
        unchanged++;
        report.unchanged.push(e.id);
      } else {
        renameSync(archive, path.join(outDir, fileName));
        changed++;
        report.changed.push(e.id);
      }
    } catch (err) {
      const text = ((err as { stderr?: string }).stderr ?? (err as Error).message).trim().split("\n");
      const error = text.find((l) => /Error:/.test(l)) ?? text.pop() ?? "unknown error";
      failures.push(`${e.id}: ${error}`);
      report.failed.push({ id: e.id, error });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    if (++done % 25 === 0) console.log(`[rebuild-changed-packs] ${done}/${entries.length} (${changed} changed, ${failures.length} failed)`);
  });

  writeFileSync(path.join(outDir, "rebuild-report.json"), JSON.stringify(report, null, 2));
  console.log(`[rebuild-changed-packs] ${changed} changed (in ${outDir}), ${unchanged} unchanged, ${notBuilt} produced no archive, ${failures.length} failed`);
  for (const f of failures.slice(0, 50)) console.log(`  failed ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
