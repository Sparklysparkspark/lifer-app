// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The builder uses
// the shared pool, so fixture rows are committed and deleted afterwards.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import { buildRegionPack } from "./build-region-pack.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("buildRegionPack", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-"));
  const regionIds: string[] = [];
  const speciesIds: string[] = [];

  async function region(name: string, parentId: string | null): Promise<string> {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, nearby_sea_zone_ids, occurrence_computed_at)
         VALUES ($1, $2, '{}', 'ZZ-1', '{}', now()) RETURNING id`,
        [name, parentId],
      )
    ).rows[0].id;
    regionIds.unshift(id);
    return id;
  }
  async function species(name: string, taxonClass: string, otherTaxa = false): Promise<string> {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, reference_credit, reference_license)
         VALUES ((random() * 1e9)::int, $1, $1 || ' common', $2, $3, 'Someone', 'cc-by') RETURNING id`,
        [name, taxonClass, otherTaxa],
      )
    ).rows[0].id;
    speciesIds.push(id);
    return id;
  }

  beforeAll(async () => {
    const country = await region("Zzpackland", null);
    const province = await region("Zzpack North", country);
    const bird = await species("Zzpack avis", "aves");
    const mammal = await species("Zzpack mammalis", "mammalia");
    const personal = await species("Zzpack personalis", "aves", true);
    await pool.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, focal_x, focal_y)
       VALUES ($1, 'https://example.org/zzpack.jpg', 'Photographer', 'cc-by', 0, 0.25, 0.75)`,
      [bird],
    );
    for (const id of [bird, mammal, personal])
      await pool.query(
        `INSERT INTO region_species (region_id, species_id, local_tier, seasonality, is_vagrant, tier_reason, tier_explain)
         VALUES ($1, $2, 'uncommon', '{1,2,3,4,5,6,7,8,9,10,11,12}', false, 'test reason', '{"why":"test"}')`,
        [country, id],
      );
    await pool.query(`INSERT INTO region_species (region_id, species_id, local_tier) VALUES ($1, $2, 'rare')`, [
      province,
      bird,
    ]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM region_species WHERE species_id = ANY($1)`, [speciesIds]);
    await pool.query(`DELETE FROM species_reference_photos WHERE species_id = ANY($1)`, [speciesIds]);
    await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [speciesIds]);
    for (const id of regionIds) await pool.query(`DELETE FROM regions WHERE id = $1`, [id]);
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function manifestOf(fileName: string) {
    const out = path.join(dir, `x-${fileName}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    await tar.extract({ file: path.join(dir, fileName), cwd: out });
    return JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  }

  it("writes a manifest with the checklist, provinces and gallery, without Other Taxa", async () => {
    const built = await buildRegionPack("Zzpackland", dir, null);
    expect(built).toMatchObject({ speciesCount: 2 });
    const manifest = await manifestOf(built!.fileName);

    expect(manifest).toMatchObject({
      type: "region",
      region: "Zzpackland",
      taxon: null,
      variant: "full",
      speciesCount: 2,
      seaZoneDependencies: [],
    });
    expect(manifest.contentVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.species.map((s: { scientificName: string }) => s.scientificName)).toEqual([
      "Zzpack avis",
      "Zzpack mammalis",
    ]);
    expect(manifest.species[0]).toMatchObject({
      commonName: "Zzpack avis common",
      referenceCredit: "Someone",
      displayFile: null,
      localTier: "uncommon",
      isVagrant: false,
      seasonality: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      tierReason: "test reason",
      tierExplain: { why: "test" },
      gallery: [
        {
          photoUrl: "https://example.org/zzpack.jpg",
          credit: "Photographer",
          license: "cc-by",
          sortOrder: 0,
          focalX: 0.25,
          focalY: 0.75,
          displayFile: null,
          thumbFile: null,
        },
      ],
    });
    expect(manifest.children).toHaveLength(1);
    expect(manifest.children[0]).toMatchObject({ name: "Zzpack North", ebirdRegionCode: "ZZ-1" });
    expect(manifest.children[0].species).toEqual([expect.objectContaining({ scientificName: "Zzpack avis", localTier: "rare" })]);
  });

  it("gives an unchanged checklist the same content version", async () => {
    const a = await manifestOf((await buildRegionPack("Zzpackland", dir, null))!.fileName);
    const b = await manifestOf((await buildRegionPack("Zzpackland", dir, null))!.fileName);
    expect(b.contentVersion).toBe(a.contentVersion);
  });

  it("scopes a taxon pack to that taxon, and skips a taxon with no species", async () => {
    const birds = await buildRegionPack("Zzpackland", dir, "aves");
    const manifest = await manifestOf(birds!.fileName);
    expect(manifest.taxon).toBe("aves");
    expect(manifest.species.map((s: { scientificName: string }) => s.scientificName)).toEqual(["Zzpack avis"]);
    expect(await buildRegionPack("Zzpackland", dir, "amphibia")).toBeNull();
  });
});
