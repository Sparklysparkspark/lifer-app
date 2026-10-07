// A few maintainer scripts measure distances between region outlines with PostGIS. The app never
// needs it, so plain Postgres installs don't have it: fail with the fix instead of "type
// geography does not exist" halfway through a refresh.
import type { Pool, PoolClient } from "pg";

export async function requirePostgis(db: Pool | PoolClient, script: string): Promise<void> {
  const res = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'postgis'`);
  if (res.rowCount) return;
  throw new Error(
    `${script} needs PostGIS in the database. Use the development database ` +
      "(docker compose -f docker-compose.yml -f docker/docker-compose.dev.yml up -d postgres), then run " +
      "CREATE EXTENSION postgis; in it. See the data pipeline docs.",
  );
}
