// Applies the compiled worldwide vernacular-region research (see
// packages/data-pipeline/src/build/vernacular-regions-data.ts and
// ~/.claude/plans/inaturalist-sync.md's sibling plan) to the actual `regions` table:
//
// - "grouping" countries: for each named group, create ONE new region row whose
//   boundary_geojson is a MultiPolygon merging every member province's own geometry (real,
//   unsimplified — for map rendering) and whose external_codes holds a merged, GBIF-queryable
//   MULTIPOLYGON WKT (simplified, point-budget spread across all members — see
//   wktFromMergedGeometries). Every listed member province is then reparented under the new
//   group row instead of directly under the country, so the default browsing view (children of
//   a country) shows the small set of real, familiar regions instead of dozens-to-hundreds of
//   raw provinces. A province not listed in ANY group for a "grouping" country is left alone,
//   still a direct child of the country (some countries only have a real name for PART of
//   their provinces, e.g. Sudan's Darfur/Kordofan — see the data file's own comment).
// - disconnects (either verdict): the named province is reparented to the COUNTRY'S OWN
//   PARENT (its continent) — promoted to sit alongside countries, never folded into a mainland
//   group, since it's ecologically/geographically its own destination (the Galápagos pattern).
// - "no_grouping" countries with no disconnects: untouched.
//
// Not designed to be safely re-run after a full success (would try to re-create the same
// groups again under a new id and fail the (name, parent_id) constraint) — this is a one-time
// migration pass, not an idempotent sync.
import { pool } from "../db.js";
import { VERNACULAR_GROUPINGS } from "data-pipeline/src/build/vernacular-regions-data.js";
import { wktFromMergedGeometries } from "data-pipeline/src/geometry.js";

interface ProvinceRow {
  id: string;
  name: string;
  boundary_geojson: { type: string; geometry?: { type: string; coordinates: unknown } } | null;
}

interface Counters {
  groupsCreated: number;
  provincesReparented: number;
  disconnectsPromoted: number;
  countriesSkipped: number;
  missingProvinces: number;
}

function mergedPolygonEntries(geometries: Array<{ type: string; coordinates: unknown }>): unknown[] {
  const entries: unknown[] = [];
  for (const g of geometries) {
    if (g.type === "Polygon") entries.push(g.coordinates);
    else if (g.type === "MultiPolygon") entries.push(...(g.coordinates as unknown[]));
  }
  return entries;
}

// One country's processing, isolated so an unexpected failure (e.g. a name collision with
// pre-existing bad data — hit this for real with Slovenia's own anomalous "Zasavska" province
// entry colliding with the "Zasavska" group name) can't take down the other ~175 countries'
// worth of already-validated work.
async function applyCountry(
  countryName: string,
  config: (typeof VERNACULAR_GROUPINGS)[string],
  counters: Counters,
): Promise<void> {
  const countryRes = await pool.query<{ id: string; parent_id: string }>(
    `SELECT id, parent_id FROM regions WHERE name = $1 AND has_children = true`,
    [countryName],
  );
  const country = countryRes.rows[0];
  if (!country) {
    counters.countriesSkipped++;
    console.error(`[apply-vernacular-regions] SKIP ${countryName}: not found (or not drilled) in regions table`);
    return;
  }

  const provincesRes = await pool.query<ProvinceRow>(`SELECT id, name, boundary_geojson FROM regions WHERE parent_id = $1`, [
    country.id,
  ]);
  const byName = new Map(provincesRes.rows.map((p) => [p.name, p]));

  // Disconnects apply regardless of verdict — reparent to the country's own parent (continent),
  // promoting it to sit alongside countries.
  for (const name of config.disconnects ?? []) {
    const province = byName.get(name);
    if (!province) {
      counters.missingProvinces++;
      console.error(`[apply-vernacular-regions]   ${countryName}: disconnect "${name}" not found among its provinces`);
      continue;
    }
    await pool.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [country.parent_id, province.id]);
    counters.disconnectsPromoted++;
  }

  if (config.verdict === "no_grouping" || !config.groups) return;

  for (const [groupName, memberNames] of Object.entries(config.groups)) {
    const members = memberNames
      .map((n) => byName.get(n))
      .filter((p): p is ProvinceRow => {
        if (!p) {
          counters.missingProvinces++;
          console.error(`[apply-vernacular-regions]   ${countryName} / ${groupName}: member not found`);
        }
        return p !== undefined;
      });
    if (members.length === 0) continue;

    // A single-member group named identically to its only member (e.g. North Macedonia's
    // "Skopje" group containing just the "Skopje" province) is a no-op wrapper — the province
    // is already its own distinct entry, nothing to merge, and creating a same-named parent
    // would just collide with it under the (name, parent_id) constraint. Leave it as a direct
    // child of the country instead.
    if (members.length === 1 && members[0].name === groupName) continue;

    const geometries = members
      .map((m) => m.boundary_geojson?.geometry)
      .filter((g): g is { type: string; coordinates: unknown } => g !== undefined && g !== null);

    const mergedGeometry = { type: "MultiPolygon", coordinates: mergedPolygonEntries(geometries) };
    const mergedWkt = wktFromMergedGeometries(geometries);

    // Inserted under a temporary placeholder name rather than the real groupName directly: a
    // member province can legitimately share its exact name with the group being created around
    // it (e.g. North Macedonia's "Skopje" statistical region is a 17-municipality group that
    // includes a municipality ALSO named "Skopje") — at insertion time that member is still a
    // child of the country, so a group already named "Skopje" under the same country would
    // collide with it under (name, parent_id). Renaming the group to its real name after
    // reparenting (below) is safe: the conflicting member's parent_id is the group by then, not
    // the country, so the names no longer compete for the same (name, parent_id) slot.
    const groupRes = await pool.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, external_codes, boundary_geojson, has_children)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [
        `${groupName} (pending)`,
        country.id,
        mergedWkt ? [mergedWkt] : [],
        JSON.stringify({ type: "Feature", properties: {}, geometry: mergedGeometry }),
      ],
    );
    const groupId = groupRes.rows[0].id;
    counters.groupsCreated++;

    // province_split_meaningful = false reuses recompute-all-regions.ts's existing "skip this
    // province in the full pass" filter (see its own WHERE clause) — a province folded into a
    // vernacular group has no fine-grained checklist of its own anymore (per the decision not
    // to keep a separate fine-drill-down option), so it should never be recomputed
    // individually; only the merged group above needs the real GBIF pass.
    await pool.query(`UPDATE regions SET parent_id = $1, province_split_meaningful = false WHERE id = ANY($2)`, [
      groupId,
      members.map((m) => m.id),
    ]);
    counters.provincesReparented += members.length;

    await pool.query(`UPDATE regions SET name = $1 WHERE id = $2`, [groupName, groupId]);
  }

  console.log(`[apply-vernacular-regions] ${countryName}: applied`);
}

async function main() {
  const counters: Counters = {
    groupsCreated: 0,
    provincesReparented: 0,
    disconnectsPromoted: 0,
    countriesSkipped: 0,
    missingProvinces: 0,
  };

  for (const [countryName, config] of Object.entries(VERNACULAR_GROUPINGS)) {
    try {
      await applyCountry(countryName, config, counters);
    } catch (err) {
      counters.countriesSkipped++;
      console.error(`[apply-vernacular-regions] FAILED ${countryName}, skipping (data left as-is for this country):`, err);
    }
  }

  console.log(
    `[apply-vernacular-regions] done. ${counters.groupsCreated} groups created, ${counters.provincesReparented} provinces reparented, ` +
      `${counters.disconnectsPromoted} disconnects promoted, ${counters.countriesSkipped} countries skipped, ${counters.missingProvinces} missing-province warnings.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
