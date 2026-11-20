import type { Queryable } from "@lifer/core/lib/http.js";
import type { ProvinceEntry } from "@lifer/core/regions/regionBoundary.js";

/** Creates a country's provinces from Natural Earth admin-1 rows. Idempotent: existing ones are kept. */
export async function createProvinces(db: Queryable, countryId: string, provinces: ProvinceEntry[]): Promise<void> {
  if (provinces.length > 0) {
    await db.query(
      `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson, is_overseas_territory, subdivision_type)
       SELECT p.name, $1::uuid, CASE WHEN p.code IS NULL THEN '{}'::text[] ELSE ARRAY[p.code] END, p.code, p.feature::jsonb, p.overseas, p.type
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[]) AS p(name, code, feature, overseas, type)
       ON CONFLICT (name, parent_id) DO NOTHING`,
      [
        countryId,
        provinces.map((p) => p.name),
        provinces.map((p) => p.iso3166_2 ?? null),
        provinces.map((p) => JSON.stringify(p.feature)),
        provinces.map((p) => p.isOverseasTerritory),
        provinces.map((p) => p.type),
      ],
    );
  }
  await db.query(`UPDATE regions SET has_children = true WHERE id = $1`, [countryId]);
}
