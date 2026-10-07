// Daily housekeeping: drop expired sessions so the table doesn't grow forever. Uploads nobody
// imported are cleared more often, since they can be gigabytes.
import { pool } from "@lifer/core/db.js";
import { sweepStagedUploads } from "./stagedUploads.js";
import { sweepTusUploads } from "./tusUploads.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const UPLOAD_SWEEP_MS = 10 * 60 * 1000;

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

async function purgeExpiredAuthRows(): Promise<{ sessions: number }> {
  const sessions = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return { sessions: sessions.rowCount ?? 0 };
}

/** Removes expired staged photos, scratch files and resumable uploads. */
export async function sweepAbandonedUploads(now = Date.now()): Promise<{ resumable: number }> {
  await sweepStagedUploads(now, true);
  return { resumable: await sweepTusUploads(now) };
}

export function startMaintenance(log: Log): void {
  const sweepUploads = () => {
    sweepAbandonedUploads()
      .then((n) => {
        if (n.resumable) log.info(n, "Removed expired resumable uploads");
      })
      .catch((err) => log.warn({ err }, "Upload cleanup failed"));
  };
  setTimeout(sweepUploads, FIRST_RUN_DELAY_MS).unref();
  setInterval(sweepUploads, UPLOAD_SWEEP_MS).unref();

  const run = () => {
    purgeExpiredAuthRows()
      .then((n) => {
        if (n.sessions) log.info(n, "Removed expired sessions");
      })
      .catch((err) => log.warn({ err }, "Expired session cleanup failed"));
  };
  setTimeout(run, FIRST_RUN_DELAY_MS).unref();
  setInterval(run, DAY_MS).unref();
}
