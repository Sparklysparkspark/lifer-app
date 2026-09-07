#!/bin/bash
# Scheduler-agnostic wrapper around refresh-all-provinces.ts, meant to be pointed at by
# whatever recurring scheduler you actually use — cron, a systemd timer (see lifer-refresh.timer
# in this same directory), a NAS's own task scheduler, anything that can run a shell command on
# an interval. This script itself is NOT installed/enabled anywhere by default — wiring it into
# an actual schedule is a separate, deliberate step.
#
# What this adds on top of just calling refresh-all-provinces.ts directly:
#   - A lock file, so an overrun run (GBIF having a slow day) can never overlap with the next
#     scheduled trigger and have two copies fighting over the same DB rows/checkpoint file.
#   - A timestamped log file per run, with old ones pruned automatically, so a year-old
#     unattended run is still debuggable without manually redirecting output every time.
#   - A real, correct exit code — refresh-all-provinces.ts itself already exits non-zero if any
#     country still fails after its own internal retry passes; this script propagates that
#     exit code, which is the hook your scheduler needs for cron's own failure mail, systemd's
#     OnFailure=, or any other "something's stale, a human should look" notification. No
#     emailing/alerting logic is built here directly — that's a credential (SMTP, a webhook
#     URL, etc.) this script deliberately never needs to hold, and your scheduler almost
#     certainly already has its own way to react to a failing job.
#
# No secrets live in this script or need to be passed to it — apps/api/src/config.ts already
# loads DATABASE_URL (and everything else) from the repo-root .env regardless of how this is
# invoked or what the caller's cwd is, exactly like every other script in src/scripts/.
#
# Usage once you're ready to actually schedule it (this is the "elsewhere" step, not done here):
#   crontab -e
#     0 0 1 1,7 * /path/to/lifer-app/packages/data-pipeline/ops/scheduled-refresh.sh
#   (runs Jan 1 and Jul 1 at midnight — twice a year, matching the "once every 6 months" ask;
#   adjust to taste, GBIF's own data doesn't change fast enough to need this more often.)
#
# Or see lifer-refresh.service / lifer-refresh.timer in this same directory for the systemd
# equivalent (also not installed/enabled — see that file's own header for how to do so).
set -uo pipefail

# flock ships built in on Linux (util-linux) — the expected target here given the systemd units
# alongside this script and the Docker/NAS self-hosted deployment this project already targets.
# macOS does NOT ship it by default (`brew install flock` if scheduling this from a Mac instead).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"
LOG_DIR="$REPO_ROOT/packages/data-pipeline/data/build/logs"
LOCK_FILE="$REPO_ROOT/packages/data-pipeline/data/build/scheduled-refresh.lock"
KEEP_LOGS=12 # ~6 years of history at the recommended twice-a-year cadence

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/refresh-$TIMESTAMP.log"

# flock holds the lock for the lifetime of this whole script (fd 200), not just one command —
# if a previous run is still going when the next scheduled trigger fires, this one exits
# immediately (9) rather than queuing up behind it or racing it.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[scheduled-refresh] another run is already in progress (lock: $LOCK_FILE) — exiting" | tee -a "$LOG_FILE"
  exit 9
fi

{
  echo "[scheduled-refresh] starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cd "$API_DIR"
  npx tsx src/scripts/refresh-all-provinces.ts --apply --refresh-gbif-cache
  code=$?
  echo "[scheduled-refresh] finished at $(date -u +%Y-%m-%dT%H:%M:%SZ), exit code $code"
  # Re-asserts $code as the exit status of this whole `{ }` group — plain `exit` here would
  # terminate the script itself (a `{ }` group runs in the current shell, not a subshell),
  # skipping the log-pruning step below entirely.
  (exit "$code")
} > >(tee -a "$LOG_FILE") 2>&1
EXIT_CODE=$?

# Prune old logs, oldest first, keeping the most recent KEEP_LOGS.
ls -1t "$LOG_DIR"/refresh-*.log 2>/dev/null | tail -n +$((KEEP_LOGS + 1)) | xargs -r rm --

exit "$EXIT_CODE"
