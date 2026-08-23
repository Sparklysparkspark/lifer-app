#!/bin/bash
# Waits for the enrich-all-species.ts process (PID 96755) to exit, then automatically runs
# the full region-compute pass, then the common-name backfill. Meant to be started once and
# left running in the background — not a recurring/cron job, just a one-time queue for this
# particular wait so these don't compete with enrichment for GBIF's rate limit.
ENRICH_PID=96755
echo "[wait-for-enrichment] watching PID $ENRICH_PID, will start compute-all-regions.ts once it exits"
while kill -0 "$ENRICH_PID" 2>/dev/null; do
  sleep 60
done
echo "[wait-for-enrichment] enrichment process exited, starting compute-all-regions.ts"
cd /Users/judahstarkey/Development/lifer-app/apps/api
npx tsx src/scripts/compute-all-regions.ts

echo "[wait-for-enrichment] compute-all-regions.ts finished, starting backfill-common-names.ts"
cd /Users/judahstarkey/Development/lifer-app/packages/data-pipeline
npx tsx src/scripts/backfill-common-names.ts
