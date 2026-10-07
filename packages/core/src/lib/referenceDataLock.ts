// The big writers of species reference data (vector installs, pack install and removal, catalog
// updates) each run one long transaction over the same rows and would deadlock if run together.
// Each takes this lock right after BEGIN so they serialize; it's released at COMMIT or ROLLBACK.
// Small one-row writes don't take it: they can only wait, never deadlock.
import type { PoolClient } from "pg";

// Any fixed number unique to this lock; "lifr" in ASCII.
const REFERENCE_DATA_LOCK_KEY = 0x6c696672;

export async function lockReferenceData(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [REFERENCE_DATA_LOCK_KEY]);
}
