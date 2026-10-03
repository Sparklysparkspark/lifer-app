#!/bin/sh
# Server admin commands (reset-password, list-users). See apps/api/src/admin/liferAdmin.ts.
cd /app/apps/api && exec node --import tsx src/admin/liferAdmin.ts "$@"
