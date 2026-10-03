// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run apply.integration
// applyPack: a pack replaces its region's checklist for its taxon, and reports species it skipped.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import * as tar from "tar";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.APP_DATA_DIR = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lifer-pack-data-"));
});

const url = process.env.TEST_DATABASE_URL;
const COUNTRY = "Zzpackland";
const PROVINCE = "Zzpack North";
const KEPT = "99999999-9999-4999-8999-999999999901";
const DROPPED = "99999999-9999-4999-8999-999999999902";
const MAMMAL = "99999999-9999-4999-8999-999999999903";
const MINE = "99999999-9999-4999-8999-999999999904";
const NEW_IN_PACK = "99999999-9999-4999-8999-999999999905";
const ALL = [KEPT, DROPPED, MAMMAL, MINE, NEW_IN_PACK];

async function packFile(manifest: object, files: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-src-"));
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-pack-out-")), "test.pack.tar.gz");
  await tar.create({ gzip: true, file, cwd: dir }, ["manifest.json", ...Object.keys(files)]);
  return file;
}

const species = (scientificName: string) => ({
  scientificName,
  habitatDescription: null,
  referenceCredit: null,
  referenceLicense: null,
  displayFile: null,
  thumbFile: null,
  localFrequency: 10,
});

describe.skipIf(!url)("applyPack checklist replacement", () => {
  const db = new pg.Pool({ connectionString: url });
  afterAll(async () => {
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2)`, [COUNTRY, PROVINCE]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.end();
  });

  let countryId: string;
  beforeEach(async () => {
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2)`, [COUNTRY, PROVINCE]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa) VALUES
         ($1, 9901, 'Zzpacka kept', 'aves', false), ($2, 9902, 'Zzpacka dropped', 'aves', false),
         ($3, 9903, 'Zzpacka mammal', 'mammalia', false), ($4, 9904, 'Zzpacka mine', 'aves', true),
         ($5, 9905, 'Zzpacka newcomer', 'aves', false)`,
      ALL,
    );
    countryId = (await db.query<{ id: string }>(`INSERT INTO regions (name, external_codes) VALUES ($1, '{ZZP}') RETURNING id`, [COUNTRY])).rows[0].id;
    const provinceId = (await db.query<{ id: string }>(`INSERT INTO regions (name, parent_id) VALUES ($1, $2) RETURNING id`, [PROVINCE, countryId])).rows[0].id;
    for (const region of [countryId, provinceId]) {
      await db.query(`INSERT INTO region_species (region_id, species_id) SELECT $1, unnest($2::uuid[])`, [region, [KEPT, DROPPED, MAMMAL, MINE]]);
    }
  });

  async function apply(manifest: object, files?: Record<string, string>) {
    const { applyPack } = await import("./apply.js");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyPack(client, await packFile(manifest, files));
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
    }
  }

  const checklist = async (name: string) =>
    (
      await db.query<{ scientific_name: string }>(
        `SELECT s.scientific_name FROM region_species rs JOIN regions r ON r.id = rs.region_id JOIN species s ON s.id = rs.species_id
         WHERE r.name = $1 ORDER BY 1`,
        [name],
      )
    ).rows.map((r) => r.scientific_name);

  it("a bird pack replaces the region's birds and leaves its mammals and the user's Other Taxa", async () => {
    const birds = [species("Zzpacka kept"), species("Zzpacka newcomer"), species("Zzpacka unknown")];
    const result = await apply({
      type: "region",
      region: COUNTRY,
      taxon: "aves",
      species: birds,
      children: [{ name: PROVINCE, ebirdRegionCode: null, boundaryGeoJson: null, externalCodes: [], species: birds, isOverseasTerritory: false }],
    });
    const expected = ["Zzpacka kept", "Zzpacka mammal", "Zzpacka mine", "Zzpacka newcomer"];
    expect(await checklist(COUNTRY)).toEqual(expected);
    expect(await checklist(PROVINCE)).toEqual(expected);
    expect(result.skippedNames).toEqual(["Zzpacka unknown"]);
  });

  it("an all-taxa pack replaces every class", async () => {
    await apply({ type: "region", region: COUNTRY, taxon: null, species: [species("Zzpacka kept")] });
    expect(await checklist(COUNTRY)).toEqual(["Zzpacka kept", "Zzpacka mine"]);
  });

  it("a pack from before the taxon field only adds", async () => {
    await apply({ type: "region", region: COUNTRY, species: [species("Zzpacka newcomer")] });
    expect(await checklist(COUNTRY)).toEqual(["Zzpacka dropped", "Zzpacka kept", "Zzpacka mammal", "Zzpacka mine", "Zzpacka newcomer"]);
  });

  it("skips a gallery photo whose sortOrder isn't a number, so its file can't land outside the gallery folder", async () => {
    const gallery = [{ photoUrl: "https://example.org/zzpack-escape.jpg", credit: "x", license: "cc-by", sortOrder: "/../../zzpack-escape", focalX: null, focalY: null, displayFile: "g.webp", thumbFile: null }];
    await apply({ type: "region", region: COUNTRY, species: [{ ...species("Zzpacka kept"), gallery }] }, { "g.webp": "photo" });
    expect(existsSync(path.join(process.env.APP_DATA_DIR!, "zzpack-escape.webp"))).toBe(false);
    const rows = await db.query(`SELECT 1 FROM species_reference_photos WHERE species_id = $1`, [KEPT]);
    expect(rows.rowCount).toBe(0);
  });
});
