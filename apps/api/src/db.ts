import { Pool } from "pg";
import { DATABASE_URL } from "./config.js";

// pg's default idleTimeoutMillis (10s) closes pooled connections shortly after each burst of
// activity — tuned for a shared server reclaiming resources between tenants. Lifer is a
// single-user desktop app talking to its own local Postgres; there's nothing to reclaim these
// connections FOR, so tearing them down just means the next click (after any 10s+ pause) pays
// a fresh TCP+auth handshake (and a new backend process fork on Postgres' side) before it can
// even start running its query — this is the "first click after a pause is slow, the rest are
// instant" pattern. idleTimeoutMillis: 0 keeps connections open indefinitely instead.
export const pool = new Pool({ connectionString: DATABASE_URL, idleTimeoutMillis: 0 });

// Pre-warm a handful of connections at startup so even the very FIRST click of a session
// doesn't pay the cold-connection cost either — without this, the pool only opens connections
// lazily as queries actually ask for one, so a page that fires several queries at once (see
// species/routes.ts) would have to open that many fresh connections simultaneously on its
// very first hit regardless of the idle-timeout fix above.
void Promise.all(Array.from({ length: 4 }, () => pool.query("SELECT 1"))).catch(() => {
  // Best-effort warmup — a failure here just means the first real query pays the cold-start
  // cost after all, not that startup itself should fail.
});
