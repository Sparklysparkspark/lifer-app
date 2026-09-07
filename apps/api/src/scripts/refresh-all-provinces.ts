// Runs compute-provinces-bulk.ts's submit → poll → download → point-in-polygon cycle for every
// country in the catalog. Defaults to one country at a time (see DEFAULT_CONCURRENCY below) —
// both because GBIF's real per-account download-concurrency limit is undocumented and stricter
// than its own "3 simultaneous" error message suggests in practice (even 3 workers from this
// script alone reliably drew 420 rejections — see compute-provinces-bulk.ts's downloadZip
// comment), AND because each worker gets a 16GB heap ceiling that's only safe with the whole
// machine's RAM to itself. Raise --concurrency= only alongside a smaller per-worker heap.
//
// Checkpointed to a JSON file: each country's name is appended and flushed the instant it
// succeeds, so killing this process and re-running the same command skips everything already
// done and picks up where it left off. A country that still fails after this run's own retry
// passes (see MAX_RETRY_PASSES below) is logged but not checkpointed, so it's picked up again
// automatically the next time this script runs — no human needs to notice and re-invoke it by
// hand for that to happen, which is what makes this safe to run unattended on a schedule (see
// packages/data-pipeline/ops/ for the actual scheduling infrastructure).
//
// compute-provinces-bulk.ts caches each country's raw GBIF download and reuses it on a later
// run instead of re-downloading (see its own GBIF_COUNTRY_CACHE_DIR comment) — a --reset-
// checkpoint redo (e.g. after a LOGIC change, not a data change) hits the cache instead of GBIF
// again for every country already downloaded once, which is most of why re-running this after
// changing tier/hotspot logic is fast. Pass --refresh-gbif-cache through to force a real
// re-download everywhere instead (e.g. after enough time has passed that GBIF's own data itself
// is expected to have changed).
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
import { pool } from "../db.js";

// 1, not 2 — runCompute below unconditionally gives each child a 16GB heap ceiling, which is
// only safe when a single worker has the whole machine's spare RAM to itself (see its own
// comment). A concurrency of 2+ needs a smaller --max-old-space-size passed alongside it, not
// just a bigger --concurrency flag, or two workers can together exceed physical RAM and cause
// OS-level swap-thrashing — a much worse failure than one process cleanly crashing.
const DEFAULT_CONCURRENCY = 1;

// Each concurrent country gets its own child process (own stdout, own DB connection, own GBIF
// download job) — the only shared, order-sensitive state across them is the in-memory checkpoint
// object below, and every mutation of it happens synchronously (no `await` in between the push
// and the write), so concurrent workers can never interleave a lost update despite sharing one
// JS event loop.
function runCompute(name: string, apply: boolean, refreshCache: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const computeArgs = ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${name}`];
    if (apply) computeArgs.push("--apply");
    if (refreshCache) computeArgs.push("--refresh-gbif-cache");
    // Australia OOM-crashed the default ~4GB V8 heap while processing its own (much larger than
    // most countries') occurrence volume — every point/cluster/week-bucket structure this script
    // builds stays in memory for the whole country, with no streaming/spill-to-disk fallback.
    // 8192 wasn't enough either (Australia climbed to ~8GB and still OOM'd) — raising further
    // here only makes sense at concurrency=1 (see this file's own DEFAULT_CONCURRENCY comment):
    // two workers each asking for double-digit GB could together exceed a 24GB machine's actual
    // physical RAM, which risks the OS swapping and grinding everything to a crawl — a much worse
    // failure than one process cleanly crashing. 16GB is safe only because a single worker has
    // the whole machine's spare capacity to itself.
    const child = spawn("npx", computeArgs, {
      cwd: API_DIR,
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

// GBIF's own download wait (submit -> poll -> fetch) is the real bottleneck for a country
// that's never been downloaded before — pure network I/O, negligible CPU/RAM — while the main
// pool above is deliberately serialized (concurrency=1) because ITS bottleneck is a
// memory-heavy processing pass. Those are two completely different resource profiles, so this
// is the SOLE owner of GBIF download submissions: it walks the exact same country list in the
// exact same order as the main pool, --cache-only (no processing, no DB writes, no --apply — it
// only ever writes a zip into the shared GBIF cache directory), so a country the main pool
// hasn't reached yet is virtually always already cached locally by the time it gets there. The
// main pool's own compute-provinces-bulk.ts (see waitForOrEnsureGbifZipCached there) waits for
// this queue to produce the file rather than submitting its own redundant download — it only
// ever falls back to submitting one directly as a last-resort correctness backstop, not as a
// second, competing download path. That split is what lets this run at the FULL GBIF ceiling
// (3 concurrent downloads, its own documented "3 simultaneous" per-account limit) instead of
// reserving a slot for a main-pool download that, in the normal case, should never happen.
// submitDownload also checks GBIF's own account state before every submission now (see
// waitForFreeDownloadSlot there) rather than assuming a fixed concurrency number is safe, so an
// occasional contention blip (another process, a leftover download from a killed run) costs a
// short wait, not a 420 failure.
const DOWNLOAD_QUEUE_CONCURRENCY = 3;
function runDownloadQueueItem(name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/scripts/compute-provinces-bulk.ts", `--countries=${name}`, "--cache-only"], {
      cwd: API_DIR,
      stdio: "inherit",
    });
    // Best-effort only, by design — a failed queue item just means the main pool's own
    // correctness-backstop fallback pays for the download later, exactly as if this queue
    // didn't run at all. Never worth retrying or surfacing as a failure in its own right.
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
  const refreshCache = args.includes("--refresh-gbif-cache");
  const checkpointPath = path.resolve(args.find((a) => a.startsWith("--checkpoint="))?.split("=")[1] ?? DEFAULT_CHECKPOINT_PATH);
  const countriesArg = args.find((a) => a.startsWith("--countries="))?.split("=")[1];
  const concurrency = Math.max(1, Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? DEFAULT_CONCURRENCY));

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
    `[refresh-all-provinces] ${targetCountries.length} target countries, ${alreadyDone.size} already done (checkpoint: ${checkpointPath}), ${remaining.length} remaining, concurrency=${concurrency}`,
  );

  // Runs one pass of the worker pool over `names`, checkpointing each success as it happens and
  // returning whatever's left over. Extracted out of main() so a failure can be retried within
  // the SAME invocation (see the retry loop below) instead of only ever getting fixed by a human
  // noticing the failure list and re-running the whole command by hand — the entire point of
  // hardening this for an unattended scheduled run.
  async function runBatch(names: string[]): Promise<{ succeeded: number; failed: string[] }> {
    let succeeded = 0;
    const failed: string[] = [];
    let nextIdx = 0;

    // A fixed-size pool of workers, each pulling the next unclaimed country off `names` as
    // soon as it finishes its own — not a fixed batch-of-N-then-wait, so a country that happens
    // to take longer than its siblings never stalls the other workers waiting on it.
    async function worker(): Promise<void> {
      for (;;) {
        const i = nextIdx++;
        if (i >= names.length) return;
        const name = names[i];
        console.log(`[refresh-all-provinces] (${i + 1}/${names.length}) ${name}`);
        try {
          await runCompute(name, apply, refreshCache);
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
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, () => worker()));
    return { succeeded, failed };
  }

  // Most real-world failures seen so far (a dropped GBIF connection, a transient timeout) are
  // one-off blips that succeed on a plain retry — see this file's own header comment on the
  // Colombia ConnectTimeoutError case, which historically only ever got "fixed" by a human
  // noticing the failure list and re-running the command later. For an unattended scheduled run
  // there's no human to notice, so retry the failed list a few times, with a short backoff (a
  // blip needs a moment to clear, not an instant retry), before finally giving up on a country.
  const MAX_RETRY_PASSES = 2;
  const RETRY_BACKOFF_MS = 60_000;

  // Started once, over the FULL remaining list, and left running concurrently with every retry
  // pass below — not restarted per pass, since by the time a country reaches a retry it was
  // already either fully processed (succeeded) or already went through its own correctness-
  // backstop download attempt (see waitForOrEnsureGbifZipCached in compute-provinces-bulk.ts),
  // so queuing it again buys nothing more there. Only awaited at the very end, so this never
  // leaves an orphaned child process running past main()'s own exit.
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
  // Nonzero on any country that never succeeded even after retries — the signal a scheduler
  // (cron's own failure mail, systemd's OnFailure=, etc.) needs to tell "ran clean" apart from
  // "ran but something's still stale," since nothing else surfaces that in an unattended run.
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
