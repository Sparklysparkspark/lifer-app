#!/usr/bin/env bash
# End-to-end test of the desktop app's PostgreSQL major upgrade (src/pg_upgrade.rs), the way an
# existing install meets it: a data folder made by the previous major, upgraded by the next
# release's bundled server.
#
# Usage: apps/desktop/src-tauri/tests/pg-upgrade-test.sh <old-pg-dir> <new-pg-dir> [rust-target]
#   <old-pg-dir>, <new-pg-dir>: PostgreSQL installs (bin, lib, share), e.g. from
#     scripts/build-postgres-macos.sh <dir> arm64 17 and scripts/build-postgres-macos.sh <dir> arm64.
#     The new one needs the tools the app bundles (pg_upgrade, pg_dump, ...).
#   [rust-target]: a cargo --target for the Rust tests, e.g. x86_64-apple-darwin to run the Intel
#     build under Rosetta (with x86_64 PostgreSQL builds).
#
# 1. Makes a cluster with the old server as postgresql_embedded does (superuser postgres, password
#    auth, UTF8, the environment's locale), on its own port and socket, never 5432.
# 2. Runs Lifer's full migrations against it, loads tests/pg-upgrade/sentinel.sql, and records
#    tests/pg-upgrade/fingerprint.sql's output.
# 3. Runs the #[ignore] pg_upgrade_* tests in src/pg_upgrade.rs, which upgrade copies of it with
#    each method (clone or copy, copy, dump and restore), kill one mid-upgrade and relaunch, and
#    check the fingerprint, the extensions and that the trigram indexes are used.
# 4. Starts the API (apps/api/dist, else the one prepare-resources staged) on the upgraded
#    database and waits for /health.
#
# Needs Node and the repo's npm dependencies (for the migrations), and Rust. Uses
# LIFER_PG_UPGRADE_TEST_WORK (default: a new folder under $TMPDIR) and removes it afterwards
# unless KEEP_WORK=1.
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <old-pg-dir> <new-pg-dir> [rust-target]" >&2
  exit 2
fi
OLD_PG="$(cd "$1" && pwd)"
NEW_PG="$(cd "$2" && pwd)"
RUST_TARGET="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$SRC_TAURI/../../.." && pwd)"

RUN=()
if [ "$RUST_TARGET" = "x86_64-apple-darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  RUN=(arch -x86_64)
fi
pg() { ${RUN[@]+"${RUN[@]}"} "$@"; }

OLD_MAJOR="$(pg "$OLD_PG/bin/postgres" --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
NEW_MAJOR="$(pg "$NEW_PG/bin/postgres" --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
echo "[pg-upgrade-test] PostgreSQL $OLD_MAJOR -> $NEW_MAJOR${RUST_TARGET:+ ($RUST_TARGET)}"

WORK="${LIFER_PG_UPGRADE_TEST_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/lifer-pg-upgrade-test.XXXXXX")}"
mkdir -p "$WORK"
# Unix socket paths must stay under about 100 bytes.
SOCK="$(mktemp -d /tmp/lpgut.XXXXXX)"
OLD_DATA="$WORK/template/app-data/postgres-data"
cleanup() {
  for d in "$OLD_DATA" "${API_DATA:-/nonexistent}"; do
    if [ -f "$d/postmaster.pid" ]; then
      pg "$OLD_PG/bin/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1 ||
        pg "$NEW_PG/bin/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1 || true
    fi
  done
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" 2>/dev/null || true; fi
  rm -rf "$SOCK"
  if [ "${KEEP_WORK:-0}" != 1 ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# The resources folder a release that changed majors ships: postgres/ (new) and
# postgres-previous/<old major>/.
RES="$WORK/resources"
mkdir -p "$RES/postgres-previous"
ln -s "$NEW_PG" "$RES/postgres"
ln -s "$OLD_PG" "$RES/postgres-previous/$OLD_MAJOR"

echo "[pg-upgrade-test] creating a PostgreSQL $OLD_MAJOR cluster as postgresql_embedded does"
mkdir -p "$WORK/template/app-data"
PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
(umask 077 && printf '%s' "$PASSWORD" >"$WORK/template/app-data/postgres-password")
(umask 077 && printf '%s' "$PASSWORD" >"$WORK/pwfile")
pg "$OLD_PG/bin/initdb" -D "$OLD_DATA" -U postgres --auth=password --pwfile="$WORK/pwfile" \
  --encoding=UTF8 >"$WORK/initdb.log"
rm -f "$WORK/pwfile"
PORT="$(free_port)"
if [ "$PORT" = 5432 ]; then PORT="$(free_port)"; fi
pg "$OLD_PG/bin/pg_ctl" -D "$OLD_DATA" -l "$WORK/old.log" -w \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -k $SOCK" start >/dev/null
export PGPASSWORD="$PASSWORD"
psql_old() { pg "$NEW_PG/bin/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_old -d postgres -c "CREATE DATABASE lifer"
URL="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/lifer"

echo "[pg-upgrade-test] running Lifer's migrations"
(cd "$REPO/packages/data-pipeline" && DATABASE_URL="$URL" npx tsx src/migrate.ts >"$WORK/migrate.log")
psql_old -d lifer -f "$HERE/pg-upgrade/sentinel.sql"
psql_old -d lifer -A -t -f "$HERE/pg-upgrade/fingerprint.sql" >"$WORK/template/fingerprint.txt"
echo "[pg-upgrade-test] fingerprint: $(cat "$WORK/template/fingerprint.txt")"
pg "$OLD_PG/bin/pg_ctl" -D "$OLD_DATA" -m fast -w stop >/dev/null
unset PGPASSWORD

echo "[pg-upgrade-test] upgrading copies of it (cargo test)"
TARGET_ARGS=()
if [ -n "$RUST_TARGET" ]; then TARGET_ARGS=(--target "$RUST_TARGET"); fi
(
  cd "$SRC_TAURI"
  LIFER_PG_UPGRADE_TEST_TEMPLATE="$WORK/template" LIFER_PG_UPGRADE_TEST_RESOURCES="$RES" \
    LIFER_PG_UPGRADE_TEST_OUT="$WORK/out" \
    cargo test --lib ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} pg_upgrade:: -- --ignored --test-threads=1 --nocapture
)

echo "[pg-upgrade-test] starting the API on the upgraded database"
API_DATA="$WORK/out/auto/app-data/postgres-data"
API_PORT="$(free_port)"
PG_PORT="$(free_port)"
pg "$NEW_PG/bin/pg_ctl" -D "$API_DATA" -l "$WORK/new.log" -w \
  -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k $SOCK" start >/dev/null
URL="postgres://postgres:$PASSWORD@127.0.0.1:$PG_PORT/lifer"
# The migrations again, as the app runs them on every launch: nothing left to apply.
(cd "$REPO/packages/data-pipeline" && DATABASE_URL="$URL" npx tsx src/migrate.ts >"$WORK/migrate-again.log")
if grep -q "^apply" "$WORK/migrate-again.log"; then
  echo "[pg-upgrade-test] ERROR: migrations applied again after the upgrade" >&2
  exit 1
fi
# The repo's API build (npm run build -w api), which matches the migrations above, else the staged one.
API_ENTRY="$REPO/apps/api/dist/index.js"
if [ ! -f "$API_ENTRY" ]; then API_ENTRY="$SRC_TAURI/resources-staging/api/dist/index.js"; fi
mkdir -p "$WORK/api-data" "$WORK/api-app-data"
(
  cd "$(dirname "$(dirname "$API_ENTRY")")"
  # As api.rs starts it: single-user mode only runs with the app's per-launch values.
  LIFER_LAUNCH_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')" \
    LIFER_LAUNCH_ID="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')" \
    PORT="$API_PORT" NODE_ENV=production SINGLE_USER_MODE=1 DATABASE_URL="$URL" \
    DATA_DIR="$WORK/api-data" APP_DATA_DIR="$WORK/api-app-data" exec node "$API_ENTRY"
) >"$WORK/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >"$WORK/health.json" 2>/dev/null; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    tail -30 "$WORK/api.log" >&2
    echo "[pg-upgrade-test] ERROR: the API exited" >&2
    exit 1
  fi
  sleep 1
done
if [ ! -s "$WORK/health.json" ]; then
  tail -30 "$WORK/api.log" >&2
  echo "[pg-upgrade-test] ERROR: the API didn't answer /health" >&2
  exit 1
fi
echo "[pg-upgrade-test] /health: $(cat "$WORK/health.json")"
kill "$API_PID" && wait "$API_PID" 2>/dev/null || true
API_PID=""
pg "$NEW_PG/bin/pg_ctl" -D "$API_DATA" -m fast -w stop >/dev/null
echo "[pg-upgrade-test] passed: PostgreSQL $OLD_MAJOR -> $NEW_MAJOR"
