import { inBatches } from "../sync/yield";
import type { Db } from "./db";

export interface RegionRow {
  key: string;
  name: string;
  source: "hub" | "pack";
  hubRegionId: string | null;
  speciesCount: number;
  bytes: number;
}

/** Rough on-phone size of a checklist: a name, a flag and index entries. */
export const BYTES_PER_SPECIES = 120;

export interface RegionSpecies {
  scientificName: string;
  commonName: string | null;
  taxonClass: string | null;
  tier: string | null;
  vagrant: boolean;
  sensitive: boolean;
  /** For group words in search ("predators"); absent until the hub sends them. */
  taxonOrder?: string | null;
  family?: string | null;
}

/** Keeps a region's checklist offline (replacing any earlier copy) and teaches the species table its names. */
export async function saveRegion(
  db: Db,
  region: Omit<RegionRow, "speciesCount" | "bytes">,
  items: RegionSpecies[],
  now: Date,
): Promise<void> {
  // Batches of 200, each its own short transaction: a mirror of thousands of species must not hold the database.
  await db.run("DELETE FROM region_species WHERE region_key = ?", [region.key]);
  await inBatches(items, 200, (batch) =>
    db.tx(async () => {
      for (const s of batch) {
        await db.run(
          `INSERT INTO species (scientific_name, common_name, taxon_class, tier, sensitive, taxon_order, family)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (scientific_name) DO UPDATE SET common_name = COALESCE(excluded.common_name, species.common_name),
             taxon_class = COALESCE(excluded.taxon_class, species.taxon_class),
             taxon_order = COALESCE(excluded.taxon_order, species.taxon_order),
             family = COALESCE(excluded.family, species.family),
             tier = COALESCE(excluded.tier, species.tier), sensitive = MAX(species.sensitive, excluded.sensitive)`,
          [
            s.scientificName,
            s.commonName,
            s.taxonClass,
            s.tier,
            s.sensitive ? 1 : 0,
            s.taxonOrder ?? null,
            s.family ?? null,
          ],
        );
        await db.run("INSERT OR REPLACE INTO region_species (region_key, scientific_name, vagrant) VALUES (?, ?, ?)", [
          region.key,
          s.scientificName,
          s.vagrant ? 1 : 0,
        ]);
      }
    }),
  );
  await db.run(
    `INSERT INTO regions (key, name, source, hub_region_id, species_count, bytes, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, species_count = excluded.species_count, bytes = excluded.bytes`,
    [
      region.key,
      region.name,
      region.source,
      region.hubRegionId,
      items.length,
      items.length * BYTES_PER_SPECIES,
      now.toISOString(),
    ],
  );
}

/** Removes a region's checklist. Species the person marked or photographed stay in the life list. */
export async function removeRegion(db: Db, key: string): Promise<void> {
  await db.tx(async () => {
    await db.run("DELETE FROM region_species WHERE region_key = ?", [key]);
    await db.run("DELETE FROM regions WHERE key = ?", [key]);
    await db.run(
      `DELETE FROM species WHERE scientific_name NOT IN (SELECT scientific_name FROM region_species)
         AND scientific_name NOT IN (SELECT scientific_name FROM marks)
         AND scientific_name NOT IN (SELECT scientific_name FROM captures)`,
    );
  });
}

export async function listRegions(db: Db): Promise<RegionRow[]> {
  return (
    await db.all<{
      key: string;
      name: string;
      source: "hub" | "pack";
      hub_region_id: string | null;
      species_count: number;
      bytes: number;
    }>("SELECT * FROM regions ORDER BY name COLLATE NOCASE")
  ).map((r) => ({
    key: r.key,
    name: r.name,
    source: r.source,
    hubRegionId: r.hub_region_id,
    speciesCount: r.species_count,
    bytes: r.bytes,
  }));
}

export const regionKeyForHub = (id: string): string => `hub:${id}`;
export const regionKeyForPack = (name: string): string => `pack:${name}`;

/** The kept checklists a region id stands for: a hub region id, or a standalone region's own key. */
export const regionKeysByHubId = async (db: Db, regionId: string): Promise<string[]> =>
  (
    await db.all<{ key: string }>("SELECT key FROM regions WHERE hub_region_id = ? OR key = ?", [regionId, regionId])
  ).map((r) => r.key);

export interface Progress {
  total: number;
  seen: number;
}

/** How much of a region's checklist the person has seen or photographed. */
export async function regionProgress(db: Db, key: string): Promise<Progress> {
  const r = await db.get<{ total: number; seen: number }>(
    `SELECT count(*) AS total, sum(CASE WHEN m.state IS NOT NULL OR EXISTS
       (SELECT 1 FROM captures c WHERE c.scientific_name = rs.scientific_name AND c.hidden = 0) THEN 1 ELSE 0 END) AS seen
     FROM region_species rs LEFT JOIN marks m ON m.scientific_name = rs.scientific_name WHERE rs.region_key = ?`,
    [key],
  );
  return { total: Number(r?.total ?? 0), seen: Number(r?.seen ?? 0) };
}

/** Targets not yet seen, from the given regions (every kept region when none are given), rarest first. */
export async function targetsToFind(db: Db, keys: string[] | null, limit = 50) {
  const where = keys && keys.length ? `AND rs.region_key IN (${keys.map(() => "?").join(",")})` : "";
  return db.all<{ scientificName: string; commonName: string | null; sensitive: number }>(
    `SELECT DISTINCT sp.scientific_name AS scientificName, sp.common_name AS commonName, sp.sensitive
     FROM marks m JOIN species sp ON sp.scientific_name = m.scientific_name
     JOIN region_species rs ON rs.scientific_name = m.scientific_name
     WHERE m.is_target = 1 AND m.state IS NULL ${where}
       AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.scientific_name = m.scientific_name AND c.hidden = 0)
     ORDER BY COALESCE(sp.common_name, sp.scientific_name) COLLATE NOCASE LIMIT ?`,
    [...(keys && keys.length ? keys : []), limit],
  );
}
