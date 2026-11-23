import { spawnSync } from "node:child_process";
import { log } from "@lifer/core/lib/log.js";

// Exits when the desktop shell that spawned this sidecar is gone. A force-quit SIGKILLs only the
// Tauri process and the OS doesn't cascade that to children, so the sidecar would keep holding
// LOCAL_PORT. The shell keeps our stdin pipe open, and the OS closes it however the shell dies (and
// unlike a pid, it can't be reused). Only with LIFER_PARENT_STDIN=1, so a server, a terminal or
// `< /dev/null` never trips it (apps/desktop/src-tauri/src/api.rs).
export function startParentWatchdog(): void {
  onParentGone(() => {
    log.error("[watchdog] the desktop app is gone, exiting");
    stopEmbeddedPostgres();
    process.exit(0);
  });
}

export function onParentGone(exit: () => void): void {
  if (process.env.LIFER_PARENT_STDIN !== "1") return;
  process.stdin.on("end", exit);
  process.stdin.on("close", exit);
  process.stdin.on("error", exit);
  process.stdin.resume();
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
