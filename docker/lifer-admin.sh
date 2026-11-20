#!/bin/sh
# Server admin commands (reset-password, list-users). See apps/api/src/admin/liferAdmin.ts.
set -e
# The same connection the server uses (docker/db-password.mjs).
DATABASE_URL="$(node /app/docker/db-password.mjs)"
export DATABASE_URL
cd /app/apps/api && exec node dist/liferAdmin.js "$@"
