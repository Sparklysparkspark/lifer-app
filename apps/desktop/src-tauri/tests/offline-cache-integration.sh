#!/usr/bin/env bash
# Runs offline_cache.rs's integration test against a real Lifer API and a throwaway Postgres on a
# free port, both removed afterwards. Never touches the Postgres on 5432 or the repo's .env database.
#
#   apps/desktop/src-tauri/tests/offline-cache-integration.sh
#
# Needs Postgres binaries (initdb, pg_ctl, createdb, psql): PG_BIN, else the copy the desktop app's
# embedded Postgres downloads to ~/.theseus/postgresql/<version>/bin, else PATH. Node and the repo's
# npm install for the API. LIFER_IT_API_ENTRY=dist/index.js runs the built API instead of its source.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"

if [[ -z "${PG_BIN:-}" ]]; then
  PG_BIN="$(ls -d "$HOME"/.theseus/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
bin() { if [[ -n "$PG_BIN" ]]; then echo "$PG_BIN/$1"; else command -v "$1"; fi; }

work="$(mktemp -d "${TMPDIR:-/tmp}/lifer-offline-it.XXXXXX")"
port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

cleanup() {
  "$(bin pg_ctl)" -D "$work/pg" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

"$(bin initdb)" -D "$work/pg" -U lifer --auth=trust >/dev/null
# TCP only: a socket path under a long temp dir can exceed the 103-byte limit on macOS.
"$(bin pg_ctl)" -D "$work/pg" -l "$work/pg.log" -w \
  -o "-p $port -c listen_addresses=127.0.0.1 -c unix_socket_directories=" start >/dev/null
"$(bin createdb)" -h 127.0.0.1 -p "$port" -U lifer lifer_offline_it

export DATABASE_URL="postgres://lifer@127.0.0.1:$port/lifer_offline_it"
(cd "$repo" && npm run migrate -w data-pipeline >/dev/null)

export LIFER_IT_DATABASE_URL="$DATABASE_URL"
export LIFER_IT_PSQL="$(bin psql)"
cd "$here/.."
cargo test --lib offline_cache::integration -- --ignored --nocapture
