#!/usr/bin/env bash
# Runs the full gallery top-up (npm run top-up-galleries) unattended: birds, mammals, reptiles,
# then every class (which also retries any species left unanswered). Restarts after a failure on
# a growing backoff, stops for good under the free-space floor, and keeps a status file.
#
#   nohup packages/data-pipeline/scripts/top-up-supervisor.sh >/dev/null 2>&1 &
#
# Rerun the same line to resume after a reboot: the phase is remembered, and the top-up itself
# only reads species still thin. Delete data/logs/top-up-phase to start over from birds.
set -u
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$REPO/packages/data-pipeline/data/logs"
LOG="$DIR/top-up.log"
STATUS="$DIR/top-up-status.json"
PHASE_FILE="$DIR/top-up-phase"
BASELINE_FILE="$DIR/top-up-baseline"
PID_FILE="$DIR/top-up-supervisor.pid"
MIN_FREE_GB=20
PHASES=(aves mammalia squamata,testudines all)
# About 9,500 API calls a day, under iNaturalist's 10,000; photo downloads keep their own 1 s gap.
export INAT_API_INTERVAL_MS=9100
# shortcut: reads the Docker compose database directly; switch to psql "$DATABASE_URL" if it moves.
q() { docker exec lifer-app-postgres-1 psql -U lifer -d lifer -Atc "$1" 2>/dev/null; }

mkdir -p "$DIR"
cd "$REPO" || exit 1
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE"))" >&2
  exit 1
fi
echo $$ >"$PID_FILE"

free_kb() { df -k "$REPO/data" | awk 'NR==2 {print $4}'; }
[[ -f "$BASELINE_FILE" ]] || echo "$(q 'select count(*) from species_reference_photos') $(free_kb) $(date -u +%FT%TZ)" >"$BASELINE_FILE"
read -r BASE_PHOTOS BASE_FREE_KB STARTED_AT <"$BASELINE_FILE"
phase=$(cat "$PHASE_FILE" 2>/dev/null || echo 0)
last_prog="" last_prog_at="" last_error="" next_retry=""

status() {
  local state=$1 prog photos free
  prog=$(tail -c 4000 "$LOG" 2>/dev/null | tr '\r' '\n' | grep -oE '[0-9]+/[0-9]+ species|^[0-9]+ thin species' | tail -1)
  [[ "$prog" == *" thin species" ]] && prog="0/${prog%% *} species"
  if [[ -n "$prog" && "$prog" != "$last_prog" ]]; then last_prog=$prog last_prog_at=$(date -u +%FT%TZ); fi
  photos=$(q 'select count(*) from species_reference_photos')
  free=$(free_kb)
  cat >"$STATUS.tmp" <<EOF
{
  "state": "$state",
  "phase": "$((phase + 1))/${#PHASES[@]} ${PHASES[phase]:-done}",
  "species_done_this_phase": "${last_prog% species}",
  "gallery_photos_added": $(( ${photos:-$BASE_PHOTOS} - BASE_PHOTOS )),
  "free_gb": $((free / 1048576)),
  "disk_used_since_start_gb": $(( (BASE_FREE_KB - free) / 1048576 )),
  "last_progress_at": "$last_prog_at",
  "last_error": "${last_error//[\"\\]/ }",
  "next_retry_at": "$next_retry",
  "started_at": "$STARTED_AT",
  "updated_at": "$(date -u +%FT%TZ)",
  "supervisor_pid": $$,
  "log": "$LOG"
}
EOF
  mv "$STATUS.tmp" "$STATUS"
}

backoff=900
while ((phase < ${#PHASES[@]})); do
  if (($(free_kb) < MIN_FREE_GB * 1048576)); then
    last_error="under $MIN_FREE_GB GB free, stopped"
    status stopped-low-disk
    exit 0
  fi
  echo "=== $(date -u +%FT%TZ) phase $((phase + 1)): --class=${PHASES[phase]}" >>"$LOG"
  started=$(date +%s) next_retry=""
  nice -n 19 npm run top-up-galleries -w data-pipeline -- --class="${PHASES[phase]}" --min-free-gb=$MIN_FREE_GB >>"$LOG" 2>&1 &
  child=$!
  while kill -0 $child 2>/dev/null; do
    status running
    sleep 60
  done
  wait $child
  code=$?
  echo "=== $(date -u +%FT%TZ) exit $code" >>"$LOG"
  if ((code == 0)); then
    phase=$((phase + 1))
    echo $phase >"$PHASE_FILE"
    backoff=900 last_error=""
    continue
  fi
  if ((code == 3)); then
    last_error="under $MIN_FREE_GB GB free, stopped"
    status stopped-low-disk
    exit 0
  fi
  last_error=$(tail -c 20000 "$LOG" | tr '\r' '\n' | grep -E 'Error|error|refused|failed' | tail -1 | cut -c1-300)
  # A run that went an hour was healthy, so the backoff starts small again.
  (($(date +%s) - started > 3600)) && backoff=900
  next_retry=$(date -u -r $(($(date +%s) + backoff)) +%FT%TZ)
  status backing-off
  sleep $backoff
  backoff=$((backoff * 2 > 21600 ? 21600 : backoff * 2))
done
last_error="" next_retry=""
status done
rm -f "$PID_FILE"
