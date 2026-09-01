// Runs compute-provinces-bulk.ts's own automated submit → poll → download → point-in-polygon
// cycle for EVERY country in the catalog, one at a time (not the world-scale single aggregated
// download compute-all-regions-bulk.ts uses — that one has no lat/lon and can't split into
// provinces at all, see its own header comment) — this is the "get modern/up-to-date data for
// everything, but still get real province splits" version of that idea.
//
// A full sweep is genuinely long (each country's GBIF download alone typically takes several
// minutes to prepare+run, times 200+ countries), so this is checkpointed: after each country
// SUCCEEDS, its name is appended to a small JSON file on disk and flushed immediately. Killing
// this process at any point (crash, `kill`, the machine sleeping) and re-running the exact same
// command just skips everything already in the checkpoint and picks up with the next country —
// no re-submitted GBIF downloads for countries already done, no lost progress. A country that
// FAILS is logged but not checkpointed, so it's automatically retried on the next run without
// needing to track failures separately.
//
// Usage:
//   npx tsx src/scripts/refresh-all-provinces.ts --apply
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --countries=Belgium,Japan   (a subset)
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --reset-checkpoint          (redo everything)
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --checkpoint=/path/to/file.json
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

// Resolved relative to this module's own location (same reasoning as apps/api/src/config.ts's
// own REPO_ROOT comment) rather than process.cwd(), which varies with how this is launched.
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
const API_DIR = path.join(REPO_ROOT, "apps/api");
const DEFAULT_CHECKPOINT_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/build/refresh-all-provinces-checkpoint.json");

interface Checkpoint {
  startedAt: string;
  completed: string[];
}

function loadCheckpoint(checkpointPath: string): Checkpoint {
  if (!existsSync(checkpointPath)) return { startedAt: new Date().toISOString(), completed: [] };
  return JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint;
}

function saveCheckpoint(checkpointPath: string, checkpoint: Checkpoint): void {
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (!apply) console.log(`[refresh-all-provinces] DRY RUN — pass --apply to actually write region_species`);
  const resetCheckpoint = args.includes("--reset-checkpoint");
  const checkpointPath = path.resolve(args.find((a) => a.startsWith("--checkpoint="))?.split("=")[1] ?? DEFAULT_CHECKPOINT_PATH);
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.split("=")[1];

  // Every country-level region already in the catalog (a child of a continent, which is itself
  // a direct child of World) — not fetchAllCountries()'s full real-world list, since a region
  // that doesn't exist here yet has nothing for compute-provinces-bulk.ts to attach provinces
  // to. "Seven seas (open ocean)" and Antarctica are continent-tier groupings with no countries
  // of their own, so they simply have zero children and contribute nothing here.
  const allCountriesRes = await pool.query<{ name: string }>(
    `SELECT r.name FROM regions r
     JOIN regions cont ON cont.id = r.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
     ORDER BY r.name`,
  );
  const allCountries = allCountriesRes.rows.map((r) => r.name);
  const targetCountries = countriesArg ? countriesArg.split(",").map((c) => c.trim()).filter(Boolean) : allCountries;

  const checkpoint = resetCheckpoint ? { startedAt: new Date().toISOString(), completed: [] } : loadCheckpoint(checkpointPath);
  const alreadyDone = new Set(checkpoint.completed);
  const remaining = targetCountries.filter((c) => !alreadyDone.has(c));

  console.log(
    `[refresh-all-provinces] ${targetCountries.length} target countries, ${alreadyDone.size} already done (checkpoint: ${checkpointPath}), ${remaining.length} remaining`,
  );

  let succeeded = 0;
  const failed: string[] = [];

  for (const [i, name] of remaining.entries()) {
    console.log(`[refresh-all-provinces] ${i + 1}/${remaining.length} ${name}`);
    try {
      const computeArgs = ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${name}`];
      if (apply) computeArgs.push("--apply");
      execFileSync("npx", computeArgs, { cwd: API_DIR, stdio: "inherit", env: process.env });
      succeeded++;
      // Only checkpointed on real writes — a dry run never actually changes anything, so
      // "completing" it shouldn't stop a later --apply run from doing the real work.
      if (apply) {
        checkpoint.completed.push(name);
        saveCheckpoint(checkpointPath, checkpoint);
      }
    } catch (err) {
      console.error(`[refresh-all-provinces] FAILED ${name}: ${(err as Error).message}`);
      failed.push(name);
    }
  }

  console.log(
    `[refresh-all-provinces] done. ${succeeded} succeeded, ${failed.length} failed${failed.length > 0 ? ` (${failed.join(", ")})` : ""}. Re-run the same command to retry failures and pick up anything interrupted.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
