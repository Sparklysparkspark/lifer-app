// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. pg_dump reads
// through its own connection, so fixture rows are committed and deleted afterwards.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSeedExportSchema, dropSeedExportSchema, dumpSeedSchema, SEED_SCHEMA } from "./catalogSeedExport.js";
import { resolvePgDump } from "./pgDump.js";

const url = process.env.TEST_DATABASE_URL;

function pgDumpAvailable(): boolean {
  if (!url) return false;
  try {
    resolvePgDump(url);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!url)("catalog seed export", () => {
  const db = new pg.Pool({ connectionString: url });
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-seed-"));
  let regionId: string;
  let catalogId: string;
  let otherTaxaId: string;
  let before: string;

  // Every source row the build could touch, as one comparable string.
  const snapshot = async () =>
    JSON.stringify(
      (
        await db.query(
          `SELECT
             (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM species s WHERE s.id = ANY($1)) AS species,
             (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM species_reference_photos p WHERE p.species_id = ANY($1)) AS photos,
             (SELECT jsonb_agg(to_jsonb(rs) ORDER BY rs.species_id) FROM region_species rs WHERE rs.species_id = ANY($1)) AS listings,
             (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.species_id) FROM species_traits t WHERE t.species_id = ANY($1)) AS traits`,
          [[catalogId, otherTaxaId]],
        )
      ).rows[0],
    );

  beforeAll(async () => {
    regionId = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Zzseedland') RETURNING id`)).rows[0]
      .id;
    const species = async (name: string, otherTaxa: boolean) => {
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO species (gbif_key, scientific_name, taxon_class, is_other_taxa, reference_display_path,
                                reference_thumb_path, photo_checked_at)
           VALUES ((random() * 1e9)::int, $1, 'aves', $2, '/build/display/' || $3, '/build/thumb/' || $3, now())
           RETURNING id`,
          [name, otherTaxa, name],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, display_path, thumb_path)
         VALUES ($1, 'https://example.org/' || $2 || '.jpg', 'Someone', 'cc-by', '/build/g/' || $2, '/build/gt/' || $2)`,
        [id, id],
      );
      await db.query(`INSERT INTO species_traits (species_id, source_attribution) VALUES ($1, 'test')`, [id]);
      await db.query(
        `INSERT INTO region_species (region_id, species_id, tier_explain) VALUES ($1, $2, '{"why":"test"}')`,
        [regionId, id],
      );
      return id;
    };
    catalogId = await species("Zzseed catalogus", false);
    otherTaxaId = await species("Zzseed personalis", true);
    before = await snapshot();
  });

  afterAll(async () => {
    await dropSeedExportSchema(db);
    const ids = [catalogId, otherTaxaId].filter(Boolean);
    await db.query(`DELETE FROM region_species WHERE species_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM species_traits WHERE species_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM species_reference_photos WHERE species_id = ANY($1)`, [ids]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ids]);
    if (regionId) await db.query(`DELETE FROM regions WHERE id = $1`, [regionId]);
    await db.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the catalog without paths or Other Taxa, leaving the source untouched", async () => {
    await createSeedExportSchema(db);

    const species = await db.query(`SELECT * FROM ${SEED_SCHEMA}.species WHERE id = ANY($1)`, [
      [catalogId, otherTaxaId],
    ]);
    expect(species.rows).toHaveLength(1);
    expect(species.rows[0]).toMatchObject({
      id: catalogId,
      reference_display_path: null,
      reference_thumb_path: null,
      photo_checked_at: null,
    });
    // Generated on install, and pg_dump leaves it out of COPY.
    expect(species.rows[0]).not.toHaveProperty("genus");

    const photos = await db.query(
      `SELECT species_id, display_path, thumb_path, photo_url FROM ${SEED_SCHEMA}.species_reference_photos
       WHERE species_id = ANY($1)`,
      [[catalogId, otherTaxaId]],
    );
    expect(photos.rows).toEqual([
      {
        species_id: catalogId,
        display_path: null,
        thumb_path: null,
        photo_url: `https://example.org/${catalogId}.jpg`,
      },
    ]);
    const listings = await db.query(
      `SELECT species_id, tier_explain FROM ${SEED_SCHEMA}.region_species WHERE species_id = ANY($1)`,
      [[catalogId, otherTaxaId]],
    );
    expect(listings.rows).toEqual([{ species_id: catalogId, tier_explain: null }]);
    const traits = await db.query(`SELECT species_id FROM ${SEED_SCHEMA}.species_traits WHERE species_id = ANY($1)`, [
      [catalogId, otherTaxaId],
    ]);
    expect(traits.rows).toEqual([{ species_id: catalogId }]);

    expect(await snapshot()).toBe(before);
  });

  it.skipIf(!pgDumpAvailable())("dumps the copies as public tables", async () => {
    await createSeedExportSchema(db);
    const out = path.join(dir, "seed.sql.gz");
    await dumpSeedSchema(url!, out, () => {});
    await dropSeedExportSchema(db);

    const sql = gunzipSync(readFileSync(out)).toString("utf8");
    expect(sql).toMatch(/^COPY public\.species \(/m);
    expect(sql).toMatch(/^COPY public\.region_species \(/m);
    expect(sql).toMatch(/^ALTER TABLE public\.species DISABLE TRIGGER ALL;$/m);
    expect(sql).not.toContain(`${SEED_SCHEMA}.`);
    expect(sql).toContain(catalogId);
    expect(sql).not.toContain(otherTaxaId);
    expect(sql).not.toContain("/build/display/");
    expect(sql).not.toMatch(/^COPY public\.species \(.*\bgenus\b/m);

    expect(await snapshot()).toBe(before);
    expect((await db.query(`SELECT to_regnamespace($1) AS s`, [SEED_SCHEMA])).rows[0].s).toBeNull();
  });
});
