// Pure, so the query building is unit-tested without a database.
/** A map area: photos with coordinates in the box, or with orRegionOnly also the photos set to
 *  exactly those regions that have none (they share one list, sorted and paged together). */
export function mapAreaSql(
  f: { bbox?: [number, number, number, number] | null; orRegionOnly?: string[] },
  param: (v: unknown) => string,
): string {
  const box = f.bbox
    ? `(c.lat BETWEEN ${param(f.bbox[1])} AND ${param(f.bbox[3])} AND ${
        f.bbox[0] <= f.bbox[2]
          ? `c.lon BETWEEN ${param(f.bbox[0])} AND ${param(f.bbox[2])}`
          : `(c.lon >= ${param(f.bbox[0])} OR c.lon <= ${param(f.bbox[2])})`
      })`
    : "";
  const rings = f.orRegionOnly?.length
    ? `((c.lat IS NULL OR c.lon IS NULL) AND c.region_id = ANY(${param(f.orRegionOnly)}::uuid[]))`
    : "";
  const either = [box, rings].filter(Boolean);
  return either.length > 0 ? `AND (${either.join(" OR ")})` : "";
}
