// The pipeline shares the server's connection pool (packages/core), so a script that uses both
// opens one pool, configured the same way (repo-root .env, DATABASE_URL).
export { pool } from "@lifer/core/db.js";
