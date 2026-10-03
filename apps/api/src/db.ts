import { Pool, type PoolClient } from "pg";
import { DATABASE_URL } from "./config.js";
import { lockReferenceData } from "./lib/referenceDataLock.js";
import { log } from "./lib/log.js";

// Connections stay open so a click after a pause doesn't pay for a new one. Overflow queues up to 30s.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 20),
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 0,
});

// An idle client erroring (Postgres restarted) emits "error" on the pool, which would otherwise
// kill the process. The pool drops the broken client and reconnects.
pool.on("error", (err) => {
  log.error(`[db] idle client error: ${err.message}`);
});

// Open a few connections at startup so the first page doesn't wait on them.
// Best-effort: a failure only means the first real query opens its own connection.
void Promise.all(Array.from({ length: 4 }, () => pool.query("SELECT 1"))).catch(() => {});

export interface TransactionOptions {
  /** Take the reference-data advisory lock right after BEGIN (see lib/referenceDataLock.ts). */
  lockReferenceData?: boolean;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

interface TransactionPool {
  connect(): Promise<PoolClient>;
}

// BEGIN, run fn on one client, COMMIT; ROLLBACK on any error. The client is always released,
// and a client whose ROLLBACK failed is destroyed rather than returned to the pool half-open.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: TransactionOptions = {},
  db: TransactionPool = pool,
): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    if (opts.statementTimeoutMs != null) await client.query(`SET LOCAL statement_timeout = ${Math.max(0, Math.floor(opts.statementTimeoutMs))}`);
    if (opts.lockTimeoutMs != null) await client.query(`SET LOCAL lock_timeout = ${Math.max(0, Math.floor(opts.lockTimeoutMs))}`);
    if (opts.lockReferenceData) await lockReferenceData(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: Error) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
