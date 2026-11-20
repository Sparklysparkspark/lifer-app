// Archive health: rehashes every original about every 90 days to catch files that silently
// changed (bit rot), went missing or became unreadable. An edit always bumps the modification
// time, so a new mtime just re-baselines; the same mtime with different bytes is damage.
import { stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { createJob, runningJobNames, type JobContext } from "../lib/job.js";
import { getInstallSetting, setInstallSetting } from "../lib/installSettings.js";
import { computeContentHash } from "../uploads/fileFingerprint.js";
import { lastOriginalInsertAt } from "../uploads/captureRows.js";
import { isReadableDir, resolveOriginalPaths } from "../storageVolumes/resolve.js";

export type Health = "changed" | "unreadable" | "missing" | "ignored";

interface HealthSettings {
  enabled: boolean;
  lastFullPassAt: string | null;
}

const SETTINGS_KEY = "archive_health";
const BATCH = 100;
const BYTES_PER_SECOND = 50 * 1024 * 1024;
const START_DELAY_MS = 3 * 60_000;
const RERUN_MS = 6 * 60 * 60_000;
const IMPORT_QUIET_MS = 60_000;
// Jobs that add, move or rewrite originals; a check mid-move would see a file as missing.
const BUSY_JOB = /^(trip-|library-reimport|reorganize-originals|refile-originals|storage-move)/;

// Every 90 days; a missing or unreadable file daily, so one that comes back clears soon.
const DUE = `(o.checked_at IS NULL OR o.checked_at < now() - interval '90 days'
  OR (o.health IN ('missing', 'unreadable', 'ignored') AND o.checked_at < now() - interval '1 day'))`;
const NOT_TRASHED = `(o.capture_id IS NULL OR EXISTS (
  SELECT 1 FROM captures_all c WHERE c.id = o.capture_id AND c.deleted_at IS NULL))`;
// Files the trip scan marked stale are listed with the missing ones.
const PROBLEM = `((o.health IN ('changed', 'unreadable', 'missing') OR o.stale) AND o.health IS DISTINCT FROM 'ignored')`;

export const archiveHealthJob = createJob("archive-health");

export async function getHealthSettings(): Promise<HealthSettings> {
  const stored = await getInstallSetting<Partial<HealthSettings>>(pool, SETTINGS_KEY);
  return { enabled: stored?.enabled ?? true, lastFullPassAt: stored?.lastFullPassAt ?? null };
}

async function saveHealthSettings(patch: Partial<HealthSettings>): Promise<void> {
  await setInstallSetting(pool, SETTINGS_KEY, { ...(await getHealthSettings()), ...patch });
}

export async function setArchiveHealthEnabled(enabled: boolean): Promise<void> {
  await saveHealthSettings({ enabled });
  if (enabled) startArchiveHealthPass().catch((err) => log.warn({ err }, "[archive-health] pass failed"));
  else archiveHealthJob.cancel();
}

interface DueRow {
  id: string;
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
  verified_hash: string | null;
  verified_mtime: Date | null;
  health: Health | null;
  sort_at: Date;
}

const errorCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code;

function importsBusy(): boolean {
  if (Date.now() - lastOriginalInsertAt < IMPORT_QUIET_MS) return true;
  for (const name of runningJobNames) if (BUSY_JOB.test(name)) return true;
  return false;
}

type Outcome =
  | { kind: "skip" }
  | { kind: "gone"; health: "missing" | "unreadable" }
  | { kind: "read"; hash: string; mtime: Date; size: number };

async function inspect(filePath: string): Promise<Outcome> {
  try {
    const before = await stat(filePath);
    const hash = await computeContentHash(filePath);
    return { kind: "read", hash, mtime: before.mtime, size: before.size };
  } catch (err) {
    if (errorCode(err) !== "ENOENT") return { kind: "gone", health: "unreadable" };
    // A whole folder gone is an unplugged drive or a moved library, not a lost file.
    return isReadableDir(path.dirname(filePath)) ? { kind: "gone", health: "missing" } : { kind: "skip" };
  }
}

// Writes one result. Guarded on ref, so a file moved meanwhile isn't marked from its old path.
async function record(row: DueRow, outcome: Outcome): Promise<void> {
  if (outcome.kind === "skip") return;
  if (outcome.kind === "gone") {
    const health = row.health === "ignored" ? "ignored" : outcome.health;
    await pool.query(`UPDATE originals SET health = $1, checked_at = now() WHERE id = $2 AND ref = $3`, [
      health,
      row.id,
      row.ref,
    ]);
    return;
  }
  const { hash, mtime } = outcome;
  // Flagged only when nothing legitimate could explain it: same mtime (or a seeded RAW with no
  // mtime yet) and different bytes. Anything else, including a file that came back, re-baselines.
  const damaged =
    row.health !== "ignored" &&
    row.verified_hash != null &&
    row.verified_hash !== hash &&
    (row.verified_mtime == null || row.verified_mtime.getTime() === mtime.getTime());
  if (damaged) {
    await pool.query(
      `UPDATE originals SET health = 'changed', stale = false, checked_at = now() WHERE id = $1 AND ref = $2`,
      [row.id, row.ref],
    );
  } else {
    await pool.query(
      `UPDATE originals SET verified_hash = $1, verified_mtime = $2, health = NULL, stale = false, checked_at = now()
       WHERE id = $3 AND ref = $4`,
      [hash, mtime, row.id, row.ref],
    );
  }
}

async function runPass(ctx: JobContext<unknown>, bytesPerSecond: number): Promise<null> {
  const total = Number(
    (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM originals o WHERE ${DUE} AND ${NOT_TRASHED}`)).rows[0]
      .n,
  );
  ctx.update({ total, processed: 0 });
  let processed = 0;
  // Keyset over (checked_at, id): skipped files keep their old checked_at, so the cursor moves past them.
  let cursor: { at: Date | string; id: string } = { at: "-infinity", id: "00000000-0000-0000-0000-000000000000" };
  for (;;) {
    const batch = await pool.query<DueRow>(
      `SELECT o.id, o.ref, o.volume_id, o.volume_relative_path, o.verified_hash, o.verified_mtime, o.health,
              COALESCE(o.checked_at, '-infinity'::timestamptz) AS sort_at
       FROM originals o
       WHERE ${DUE} AND ${NOT_TRASHED}
         AND (COALESCE(o.checked_at, '-infinity'::timestamptz), o.id) > ($1::timestamptz, $2::uuid)
       ORDER BY COALESCE(o.checked_at, '-infinity'::timestamptz), o.id
       LIMIT ${BATCH}`,
      [cursor.at, cursor.id],
    );
    if (batch.rows.length === 0) break;
    const resolved = await resolveOriginalPaths(batch.rows);
    for (const [i, row] of batch.rows.entries()) {
      while (importsBusy()) await sleep(30_000, undefined, { signal: ctx.signal });
      ctx.throwIfCancelled();
      const where = resolved[i];
      // A disconnected drive is picked up on a later pass, once it's attached.
      if (where.connected && where.path) {
        const started = Date.now();
        const outcome = await inspect(where.path);
        await record(row, outcome);
        // Throttled per file: a pause after each one keeps the average near bytesPerSecond.
        if (outcome.kind === "read") {
          const wait = (outcome.size / bytesPerSecond) * 1000 - (Date.now() - started);
          if (wait > 0) await sleep(wait, undefined, { signal: ctx.signal });
        }
      }
      ctx.update({ processed: ++processed });
    }
    const last = batch.rows[batch.rows.length - 1];
    cursor = { at: last.sort_at, id: last.id };
  }
  await saveHealthSettings({ lastFullPassAt: new Date().toISOString() });
  return null;
}

/** Starts a pass over every due file unless one is running or the check is off. Resolves once
 *  the pass finishes. */
export async function startArchiveHealthPass(bytesPerSecond = BYTES_PER_SECOND): Promise<void> {
  if (!(await getHealthSettings()).enabled) return;
  archiveHealthJob.start((ctx) => runPass(ctx, bytesPerSecond));
  await archiveHealthJob.settled();
}

/** A pass a few minutes after launch, then every few hours for newly due files and reattached drives. */
export function scheduleArchiveHealth(): void {
  const run = () => {
    startArchiveHealthPass()
      .catch((err) => log.warn({ err }, "[archive-health] pass failed"))
      .finally(() => setTimeout(run, RERUN_MS).unref());
  };
  setTimeout(run, START_DELAY_MS).unref();
}

export interface HealthSummary {
  enabled: boolean;
  running: boolean;
  processed: number | null;
  total: number | null;
  lastCheckedAt: string | null;
  checkedCount: number;
  problemCount: number;
  notChecked: { label: string; count: number }[];
}

export async function healthSummary(userId: string): Promise<HealthSummary> {
  const settings = await getHealthSettings();
  const counts = await pool.query<{ checked: string; problems: string }>(
    `SELECT count(*) FILTER (WHERE o.checked_at IS NOT NULL) AS checked,
            count(*) FILTER (WHERE ${PROBLEM}) AS problems
     FROM originals o WHERE o.user_id = $1 AND ${NOT_TRASHED}`,
    [userId],
  );
  // Files waiting on a drive that isn't attached, per drive.
  const waiting = await pool.query<{ volume_id: string; n: string }>(
    `SELECT o.volume_id, count(*) AS n FROM originals o
     WHERE o.user_id = $1 AND o.volume_id IS NOT NULL AND ${DUE} AND ${NOT_TRASHED}
     GROUP BY o.volume_id`,
    [userId],
  );
  const volumes = await resolveOriginalPaths(
    waiting.rows.map((r) => ({ ref: "", volume_id: r.volume_id, volume_relative_path: "" })),
  );
  const status = archiveHealthJob.status;
  return {
    enabled: settings.enabled,
    running: status.running,
    processed: status.processed,
    total: status.total,
    lastCheckedAt: settings.lastFullPassAt,
    checkedCount: Number(counts.rows[0].checked),
    problemCount: Number(counts.rows[0].problems),
    notChecked: waiting.rows
      .map((r, i) => ({ label: volumes[i].volumeLabel ?? "", count: Number(r.n), connected: volumes[i].connected }))
      .filter((v) => !v.connected)
      .map(({ label, count }) => ({ label, count })),
  };
}

// Enough for a screenful of pages; a failing drive could flag far more, which the count shows.
const PROBLEM_LIST_LIMIT = 2000;

export interface HealthProblem {
  id: string;
  path: string;
  problem: "changed" | "unreadable" | "missing";
  photoId: string | null;
  captureId: string | null;
  speciesId: string | null;
  commonName: string | null;
  scientificName: string | null;
}

export async function listHealthProblems(userId: string): Promise<{ total: number; items: HealthProblem[] }> {
  const res = await pool.query<HealthProblem & { total: string }>(
    `SELECT o.id, o.ref AS path,
            CASE WHEN o.health IN ('changed', 'unreadable') THEN o.health ELSE 'missing' END AS problem,
            c.current_photo_id AS "photoId", o.capture_id AS "captureId", s.id AS "speciesId",
            s.common_name AS "commonName", s.scientific_name AS "scientificName",
            count(*) OVER () AS total
     FROM originals o
     LEFT JOIN captures_all c ON c.id = o.capture_id
     LEFT JOIN species s ON s.id = COALESCE(c.species_id, o.species_id)
     WHERE o.user_id = $1 AND ${PROBLEM} AND ${NOT_TRASHED}
     ORDER BY o.ref
     LIMIT ${PROBLEM_LIST_LIMIT}`,
    [userId],
  );
  return {
    total: Number(res.rows[0]?.total ?? 0),
    items: res.rows.map(({ total: _total, ...item }) => item),
  };
}

// A changed file's current contents become its baseline on the next check; a missing or
// unreadable one is left out until it's readable again.
const IGNORE_SET = `health = CASE WHEN health = 'changed' THEN NULL ELSE 'ignored' END,
  verified_hash = CASE WHEN health = 'changed' THEN NULL ELSE verified_hash END,
  verified_mtime = CASE WHEN health = 'changed' THEN NULL ELSE verified_mtime END,
  checked_at = CASE WHEN health = 'changed' THEN NULL ELSE checked_at END`;

export async function ignoreHealthProblem(userId: string, id: string): Promise<boolean> {
  const res = await pool.query(`UPDATE originals SET ${IGNORE_SET} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return (res.rowCount ?? 0) > 0;
}

/** Ignores every listed problem at once, including those past the list's limit. */
export async function ignoreAllHealthProblems(userId: string): Promise<number> {
  const res = await pool.query(
    `UPDATE originals o SET ${IGNORE_SET} WHERE o.user_id = $1 AND ${PROBLEM} AND ${NOT_TRASHED}`,
    [userId],
  );
  return res.rowCount ?? 0;
}
