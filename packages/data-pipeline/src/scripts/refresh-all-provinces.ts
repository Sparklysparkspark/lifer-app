// Runs compute-provinces-bulk.ts for every country in the catalog, one at a time by default
// (each worker gets a 16GB heap). Raise --concurrency= only with a smaller per-worker heap.
//
// Checkpointed: each success is saved immediately, so re-running the same command resumes.
// Countries that still fail after the retry passes aren't checkpointed and are retried next run.
//
// GBIF downloads are cached, so --reset-checkpoint after a logic change is fast.
// --refresh-gbif-cache forces fresh downloads.
//
// Usage:
//   npx tsx src/scripts/refresh-all-provinces.ts --apply
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --concurrency=6
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --countries=Belgium,Japan   (a subset)
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --reset-checkpoint          (redo everything)
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --reset-checkpoint --refresh-gbif-cache  (redo AND re-download)
//   npx tsx src/scripts/refresh-all-provinces.ts --apply --checkpoint=/path/to/file.json
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@lifer/core/db.js";

// Each child gets a 16GB heap, so running two at once risks swap-thrashing the machine.
const DEFAULT_CONCURRENCY = 1;

// One child process per country. Checkpoint updates are synchronous, so workers can't lose one.
function runCompute(name: string, apply: boolean, refreshCache: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const computeArgs = ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${name}`];
    if (apply) computeArgs.push("--apply");
    if (refreshCache) computeArgs.push("--refresh-gbif-cache");
    // Large countries need far more than V8's default heap. 16GB is only safe at concurrency=1.
    const child = spawn("npx", computeArgs, {
      cwd: PIPELINE_DIR,
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=16384`.trim() },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`compute-provinces-bulk exited with code ${code}`));
    });
  });
}

// Download queue: fetches GBIF zips (--cache-only) ahead of the serialized processing pool, at
// GBIF's 3-download limit, so network waits overlap with processing. Processing waits for the
// queue's file rather than submitting its own download.
const DOWNLOAD_QUEUE_CONCURRENCY = 3;
function runDownloadQueueItem(name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${name}`, "--cache-only"], {
      cwd: PIPELINE_DIR,
      stdio: "inherit",
    });
    // Best-effort: if this fails, processing downloads the zip itself.
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function runDownloadQueue(names: string[]): Promise<void> {
  let nextIdx = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIdx++;
      if (i >= names.length) return;
      await runDownloadQueueItem(names[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_QUEUE_CONCURRENCY, names.length) }, () => worker()));
}

// Resolved from this module's location, not process.cwd(), which varies with how it's launched.
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
const PIPELINE_DIR = path.join(REPO_ROOT, "packages/data-pipeline");
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
  if (!apply) console.log(`[refresh-all-provinces] DRY RUN: pass --apply to actually write region_species`);
  const resetCheckpoint = args.includes("--reset-checkpoint");
  const refreshCache = args.includes("--refresh-gbif-cache");
  const checkpointPath = path.resolve(args.find((a) => a.startsWith("--checkpoint="))?.split("=")[1] ?? DEFAULT_CHECKPOINT_PATH);
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.split("=")[1];
  const concurrency = Math.max(1, Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? DEFAULT_CONCURRENCY));

  // Every country-level region already in the catalog (World > continent > country).
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
    `[refresh-all-provinces] ${targetCountries.length} target countries, ${alreadyDone.size} already done (checkpoint: ${checkpointPath}), ${remaining.length} remaining, concurrency=${concurrency}`,
  );

  // One pass of the worker pool over `names`, checkpointing each success and returning failures.
  async function runBatch(names: string[]): Promise<{ succeeded: number; failed: string[] }> {
    let succeeded = 0;
    const failed: string[] = [];
    let nextIdx = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const i = nextIdx++;
        if (i >= names.length) return;
        const name = names[i];
        console.log(`[refresh-all-provinces] (${i + 1}/${names.length}) ${name}`);
        try {
          await runCompute(name, apply, refreshCache);
          succeeded++;
          // Dry runs aren't checkpointed, so a later --apply run still does the work.
          if (apply) {
            checkpoint.completed.push(name);
            saveCheckpoint(checkpointPath, checkpoint);
          }
        } catch (err) {
          console.error(`[refresh-all-provinces] FAILED ${name}: ${(err as Error).message}`);
          failed.push(name);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, () => worker()));
    return { succeeded, failed };
  }

  // Most failures are transient network blips, so retry failed countries after a short backoff.
  const MAX_RETRY_PASSES = 2;
  const RETRY_BACKOFF_MS = 60_000;

  // Started once over the full list and awaited at the end, so no child outlives main().
  const downloadQueuePromise = runDownloadQueue(remaining);

  let totalSucceeded = 0;
  let stillFailing = remaining;
  for (let pass = 0; stillFailing.length > 0 && pass <= MAX_RETRY_PASSES; pass++) {
    if (pass > 0) {
      console.log(
        `[refresh-all-provinces] retry pass ${pass}/${MAX_RETRY_PASSES}: ${stillFailing.length} countries failed last pass, waiting ${RETRY_BACKOFF_MS / 1000}s before retrying: ${stillFailing.join(", ")}`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
    const { succeeded, failed } = await runBatch(stillFailing);
    totalSucceeded += succeeded;
    stillFailing = failed;
  }

  await downloadQueuePromise;

  const ok = stillFailing.length === 0;
  console.log(
    `[refresh-all-provinces] done. ${totalSucceeded} succeeded, ${stillFailing.length} failed after retries${
      stillFailing.length > 0 ? ` (${stillFailing.join(", ")})` : ""
    }. Re-run the same command to retry failures and pick up anything interrupted.`,
  );
  await pool.end();
  // Nonzero exit if any country still failed, so a scheduler can tell.
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
