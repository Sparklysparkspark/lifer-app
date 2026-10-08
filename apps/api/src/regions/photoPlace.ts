// The province or state and country a photo's region sits in, as names for its file's location
// fields (exif.ts). Read from the region's ancestors by their eBird codes: a country's is two
// letters ("CA"), a first-level subdivision's adds one part ("CA-BC"), and anything deeper (a
// county, "US-NY-061") adds more, so the nearest match of each is the right one.
import type { Pool, PoolClient } from "pg";
import type { PhotoPlace } from "../uploads/exif.js";

export async function photoPlaceForRegion(db: Pool | PoolClient, regionId: string | null): Promise<PhotoPlace | null> {
  if (!regionId) return null;
  const res = await db.query<{
    state: string | null;
    country: string | null;
    country_code: string | null;
    country_codes: string[] | null;
  }>(
    `WITH RECURSIVE up AS (
       SELECT id, name, parent_id, ebird_region_code, external_codes, 0 AS depth FROM regions WHERE id = $1
       UNION ALL
       SELECT r.id, r.name, r.parent_id, r.ebird_region_code, r.external_codes, up.depth + 1
         FROM regions r JOIN up ON r.id = up.parent_id WHERE up.depth < 12
     ),
     state AS (SELECT name FROM up WHERE ebird_region_code ~ '^[A-Z]{2}-[A-Z0-9]+$' ORDER BY depth LIMIT 1),
     country AS (SELECT name, ebird_region_code, external_codes FROM up WHERE ebird_region_code ~ '^[A-Z]{2}$' ORDER BY depth LIMIT 1)
     SELECT (SELECT name FROM state) AS state, (SELECT name FROM country) AS country,
            (SELECT ebird_region_code FROM country) AS country_code, (SELECT external_codes FROM country) AS country_codes`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row || (!row.state && !row.country)) return null;
  return {
    state: row.state,
    country: row.country,
    countryCode: row.country_code,
    countryCode3: row.country_codes?.find((c) => /^[A-Z]{3}$/.test(c)) ?? null,
  };
}
