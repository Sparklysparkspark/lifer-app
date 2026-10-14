// Keeps the region tree in the vernacular shape build/vernacular-regions-data.ts describes:
// country > group > province where a country has familiar regional groupings, and isolated
// provinces (disconnects) shown under the continent while staying their country's for data
// (home_country_id). Idempotent: a rerun changes nothing, and a province the province build
// (re)created directly under its country is nested again. Provinces keep their ids, so their
// partitions, checklists and tiers carry over; a group's checklist is its provinces' together
// (build-country-checklists.ts) and its tiers come from them (compute-local-tiers.ts).
import type { Pool, PoolClient } from "pg";
import { wktFromMergedGeometries } from "@lifer/core/lib/geometry.js";
import { COUNTRIES_SQL } from "@lifer/core/regions/regionTree.js";
import { VERNACULAR_GROUPINGS, type CountryGrouping } from "../build/vernacular-regions-data.js";

type Geometry = { type: string; coordinates: unknown };

interface TreeRow {
  id: string;
  name: string;
  parent_id: string;
  has_kids: boolean;
  boundary_geojson: { geometry?: Geometry } | null;
}

export interface VernacularSyncResult {
  countries: number;
  groupsCreated: number;
  provincesNested: number;
  provincesUngrouped: number;
  disconnected: number;
  /** "Country / group: name" for each listed province no region matches. */
  missing: string[];
  /** Problems that left something as it was (a name collision, an unknown group). */
  warnings: string[];
}

function mergedBoundary(members: TreeRow[]): { feature: string; wkt: string[] } {
  const geometries = members
    .map((m) => m.boundary_geojson?.geometry)
    .filter((g): g is Geometry => g != null && (g.type === "Polygon" || g.type === "MultiPolygon"));
  const polygons = geometries.flatMap((g) => (g.type === "Polygon" ? [g.coordinates] : (g.coordinates as unknown[])));
  const wkt = wktFromMergedGeometries(geometries);
  return {
    feature: JSON.stringify({
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: polygons },
    }),
    wkt: wkt ? [wkt] : [],
  };
}

async function syncCountry(
  db: PoolClient,
  country: { id: string; name: string; continent_id: string },
  config: CountryGrouping,
  result: VernacularSyncResult,
): Promise<void> {
  // Everything under the country, two levels down, and its provinces already moved to the continent.
  const tree = await db.query<TreeRow>(
    `SELECT r.id, r.name, r.parent_id, r.boundary_geojson,
            EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = r.id) AS has_kids
     FROM regions r
     WHERE r.parent_id = $1 OR r.home_country_id = $1 OR r.parent_id IN (SELECT g.id FROM regions g WHERE g.parent_id = $1)`,
    [country.id],
  );
  const leaves = new Map<string, TreeRow>();
  const ambiguous = new Set<string>();
  for (const r of tree.rows) {
    if (r.has_kids) continue;
    if (leaves.has(r.name)) ambiguous.add(r.name);
    leaves.set(r.name, r);
  }
  const leaf = (name: string, where: string): TreeRow | null => {
    if (ambiguous.has(name)) {
      result.warnings.push(`${country.name}: more than one province named "${name}", left as it is`);
      return null;
    }
    const row = leaves.get(name);
    if (!row) result.missing.push(`${country.name} / ${where}: ${name}`);
    return row ?? null;
  };
  const nameTaken = async (name: string, parentId: string, exceptId: string) =>
    ((
      await db.query(`SELECT 1 FROM regions WHERE name = $1 AND parent_id = $2 AND id <> $3`, [
        name,
        parentId,
        exceptId,
      ])
    ).rowCount ?? 0) > 0;

  for (const name of config.disconnects ?? []) {
    const row = leaf(name, "shown under its continent");
    if (!row || row.parent_id === country.continent_id) {
      if (row)
        await db.query(
          `UPDATE regions SET home_country_id = $1 WHERE id = $2 AND home_country_id IS DISTINCT FROM $1`,
          [country.id, row.id],
        );
      continue;
    }
    if (await nameTaken(name, country.continent_id, row.id)) {
      result.warnings.push(
        `${country.name}: "${name}" can't move under its continent, which has a region of that name`,
      );
      continue;
    }
    await db.query(`UPDATE regions SET parent_id = $1, home_country_id = $2 WHERE id = $3`, [
      country.continent_id,
      country.id,
      row.id,
    ]);
    result.disconnected++;
  }
  const disconnects = new Set(config.disconnects ?? []);

  // Where each grouped province belongs: its group's id, or the country for a one-province group
  // named after its only province (a wrapper would add nothing).
  const home = new Map<string, string>();
  const groups = config.verdict === "grouping" ? Object.entries(config.groups ?? {}) : [];
  for (const [groupName, memberNames] of groups) {
    const members = memberNames
      .filter((n) => !disconnects.has(n))
      .map((n) => leaf(n, groupName))
      .filter((m): m is TreeRow => m !== null);
    if (members.length === 0) continue;
    if (members.length === 1 && members[0].name === groupName) {
      home.set(members[0].id, country.id);
      continue;
    }
    const memberIds = new Set(members.map((m) => m.id));
    // A group may share its name with one of its provinces (North Macedonia's Skopje), so the
    // group is the same-named child that isn't one of them.
    const existing = tree.rows.find((r) => r.parent_id === country.id && r.name === groupName && !memberIds.has(r.id));
    let groupId = existing?.id;
    const moving = members.filter((m) => m.parent_id !== groupId);
    if (!groupId) {
      // Created under a placeholder name, since a same-named province may still sit beside it
      // under the country; renamed once its provinces are inside it.
      const boundary = mergedBoundary(members);
      groupId = (
        await db.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, external_codes, boundary_geojson, has_children)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [`${groupName} (pending)`, country.id, boundary.wkt, boundary.feature],
        )
      ).rows[0].id;
      result.groupsCreated++;
    } else if (moving.length > 0) {
      const boundary = mergedBoundary(members);
      await db.query(`UPDATE regions SET boundary_geojson = $2, external_codes = $3 WHERE id = $1`, [
        groupId,
        boundary.feature,
        boundary.wkt,
      ]);
    }
    for (const m of members) home.set(m.id, groupId);
    if (moving.length > 0) {
      await db.query(`UPDATE regions SET parent_id = $1 WHERE id = ANY($2)`, [groupId, moving.map((m) => m.id)]);
      result.provincesNested += moving.length;
    }
    await db.query(
      `UPDATE regions SET name = $2, has_children = true WHERE id = $1 AND (name <> $2 OR NOT has_children)`,
      [groupId, groupName],
    );
  }

  // Provinces inside a group the data no longer puts them in go back under the country.
  const groupIds = new Set(tree.rows.filter((r) => r.parent_id === country.id && r.has_kids).map((r) => r.id));
  for (const r of tree.rows) {
    if (r.has_kids || !groupIds.has(r.parent_id) || disconnects.has(r.name)) continue;
    const target = home.get(r.id) ?? country.id;
    if (target === r.parent_id || target !== country.id) continue;
    if (await nameTaken(r.name, country.id, r.id)) {
      result.warnings.push(
        `${country.name}: "${r.name}" can't leave its group, the country has another region of that name`,
      );
      continue;
    }
    await db.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [country.id, r.id]);
    result.provincesUngrouped++;
  }

  const known = new Set(groups.map(([name]) => name));
  for (const id of groupIds) {
    const g = tree.rows.find((r) => r.id === id)!;
    if (!known.has(g.name)) result.warnings.push(`${country.name}: group "${g.name}" isn't in the groupings data`);
  }
  // A group whose provinces all left reads as a place of its own.
  await db.query(
    `UPDATE regions g SET has_children = false
     WHERE g.parent_id = $1 AND g.has_children AND g.name = ANY($2) AND NOT EXISTS (SELECT 1 FROM regions k WHERE k.parent_id = g.id)`,
    [country.id, [...known]],
  );
}

/** Applies the groupings to every country they list. Without `apply`, works out the same
 *  changes in transactions that are rolled back. */
export async function syncVernacularRegions(
  pool: Pool,
  apply: boolean,
  groupings: Record<string, CountryGrouping> = VERNACULAR_GROUPINGS,
): Promise<VernacularSyncResult> {
  const result: VernacularSyncResult = {
    countries: 0,
    groupsCreated: 0,
    provincesNested: 0,
    provincesUngrouped: 0,
    disconnected: 0,
    missing: [],
    warnings: [],
  };
  const countries = await pool.query<{ id: string; name: string; continent_id: string }>(
    `SELECT c.id, c.name, r.parent_id AS continent_id FROM (${COUNTRIES_SQL}) c JOIN regions r ON r.id = c.id
     WHERE c.name = ANY($1)`,
    [Object.keys(groupings)],
  );
  const byName = new Map(countries.rows.map((c) => [c.name, c]));
  for (const [name, config] of Object.entries(groupings)) {
    const country = byName.get(name);
    if (!country) {
      result.warnings.push(`${name}: no such country`);
      continue;
    }
    if (config.verdict === "no_grouping" && !config.disconnects?.length) continue;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await syncCountry(db, country, config, result);
      await db.query(apply ? "COMMIT" : "ROLLBACK");
      result.countries++;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw new Error(`${name}: ${(err as Error).message}`, { cause: err });
    } finally {
      db.release();
    }
  }
  return result;
}
