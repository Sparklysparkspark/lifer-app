// region_species_rollup (migration 198): the species of each region's subtree that its own
// checklist lacks, so a continent's species are one indexed read instead of every province's rows.
// It is rebuilt in full, in the background, whenever region_checklist_version has moved on.
import { pool, withTransaction } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";

const BUILT_KEY = "region_species_rollup_version";
const CURRENT_VERSION_SQL = `(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM region_checklist_version)`;
// Any fixed key: a second process sharing the database skips a rebuild already running.
const REBUILD_LOCK = 7_420_198;

/** Whether the rollup matches the checklists as they are now. */
export async function regionRollupFresh(): Promise<boolean> {
  const { rows } = await pool.query<{ fresh: boolean }>(
    `SELECT COALESCE((SELECT (value #>> '{}')::bigint FROM install_settings WHERE key = $1) = ${CURRENT_VERSION_SQL}, false) AS fresh`,
    [BUILT_KEY],
  );
  return rows[0].fresh;
}

// The subtree is regionTreeCte's (regions/checklist.ts): the region, provinces filed under it by
// home_country_id, and everything below those.
const REBUILD_SQL = `INSERT INTO region_species_rollup (region_id, species_id)
  WITH RECURSIVE t(root, id) AS (
    SELECT id, id FROM regions
    UNION SELECT home_country_id, id FROM regions WHERE home_country_id IS NOT NULL
    UNION SELECT t.root, r.id FROM regions r JOIN t ON r.parent_id = t.id
  )
  SELECT DISTINCT t.root, rs.species_id FROM t JOIN region_species rs ON rs.region_id = t.id
  WHERE t.root <> t.id
    AND NOT EXISTS (SELECT 1 FROM region_species own WHERE own.region_id = t.root AND own.species_id = rs.species_id)`;

async function rebuild(): Promise<void> {
  const version = (await pool.query<{ v: string }>(`SELECT ${CURRENT_VERSION_SQL}::text AS v`)).rows[0].v;
  // A writer that bumped the version may not have committed yet; wait it out so the build sees
  // its rows, or it would be stamped current without them. A snapshot only lists running xids
  // below the newest finished one, so finishing an xid of our own first makes it list them all.
  await pool.query(`SELECT pg_current_xact_id()`);
  const { xip } = (
    await pool.query<{ xip: string[] }>(`SELECT ARRAY(SELECT pg_snapshot_xip(pg_current_snapshot()))::text[] AS xip`)
  ).rows[0];
  for (;;) {
    const { rows } = await pool.query<{ busy: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM unnest($1::xid8[]) x WHERE pg_xact_status(x) = 'in progress') AS busy`,
      [xip],
    );
    if (!rows[0].busy) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const started = Date.now();
  const built = await withTransaction(async (client) => {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [REBUILD_LOCK]);
    if (!lock.rows[0].ok) return null;
    // DELETE, not TRUNCATE, so tree requests keep reading the old rows until this commits.
    await client.query(`DELETE FROM region_species_rollup`);
    const res = await client.query(REBUILD_SQL);
    await client.query(
      `INSERT INTO install_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::bigint), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [BUILT_KEY, version],
    );
    return res.rowCount;
  });
  if (built != null) log.info({ rows: built, ms: Date.now() - started }, "Rebuilt the region species rollup");
}

let rebuilding: Promise<void> | null = null;
let askedAgain = false;

/** Rebuilds the rollup when it's out of date, one at a time; a call during a rebuild gets one
 *  more check after it, since its change may have come too late for it. Never throws. */
export function ensureRegionRollup(): Promise<void> {
  if (rebuilding) {
    askedAgain = true;
    return rebuilding;
  }
  rebuilding = (async () => {
    try {
      do {
        askedAgain = false;
        if (!(await regionRollupFresh())) await rebuild();
      } while (askedAgain);
    } catch (err) {
      log.error({ err }, "Couldn't rebuild the region species rollup");
    } finally {
      rebuilding = null;
    }
  })();
  return rebuilding;
}
