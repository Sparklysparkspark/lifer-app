import { spawnSync } from "node:child_process";
import { log } from "./log.js";

// Exits when the desktop shell that spawned this sidecar is gone. A force-quit SIGKILLs only the
// Tauri process and Unix doesn't cascade that to children, so the sidecar would keep holding
// LOCAL_PORT. Active only when LIFER_WATCH_PARENT_PID is set (apps/desktop/src-tauri/src/api.rs).
export function startParentWatchdog(): void {
  const parentPid = Number(process.env.LIFER_WATCH_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  setInterval(() => {
    try {
      // Signal 0 only checks that the pid exists.
      process.kill(parentPid, 0);
    } catch {
      log.error(`[watchdog] parent pid ${parentPid} is gone, exiting`);
      stopEmbeddedPostgres();
      process.exit(0);
    }
  }, 3000);
}

// The shell's embedded Postgres would otherwise outlive a crashed app. Best effort: the next
// launch also stops an orphaned instance (embedded_db.rs stop_orphaned_postgres).
function stopEmbeddedPostgres(): void {
  const pgCtl = process.env.LIFER_PG_CTL;
  const pgData = process.env.LIFER_PG_DATA;
  if (!pgCtl || !pgData) return;
  try {
    const res = spawnSync(pgCtl, ["stop", "-D", pgData, "-m", "fast", "-w"], { timeout: 10_000, stdio: "ignore" });
    if (res.error || res.status !== 0) {
      log.error(`[watchdog] pg_ctl stop failed: ${res.error?.message ?? `exit ${res.status}`}`);
    }
  } catch (err) {
    log.error({ err }, "[watchdog] pg_ctl stop failed");
  }
}
