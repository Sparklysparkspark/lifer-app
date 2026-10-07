#!/bin/sh
# Runs migrations, then replaces this shell with the server so it gets Docker's SIGTERM directly.
set -e

# The Natural Earth province cache lives under /app/data, a symlink into the app-data volume.
mkdir -p "${APP_DATA_DIR:-/app-data}/pipeline-cache" 2>/dev/null || true

cd /app/packages/data-pipeline
node dist/migrate.js

cd /app/apps/api
exec node dist/index.js
