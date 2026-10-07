#!/bin/sh
# Server admin commands (reset-password, list-users). See apps/api/src/admin/liferAdmin.ts.
cd /app/apps/api && exec node dist/liferAdmin.js "$@"
