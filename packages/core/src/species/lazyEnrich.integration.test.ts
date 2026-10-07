// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run lazyEnrich.integration
// persistEnrichment keeps species.photo_withheld (migration 123) in step with what the pipeline's
// publishable-only enrichment found.
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichmentResult } from "./lazyEnrich.js";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const SPECIES = "88888888-0000-4000-8000-000000000001";

const empty: EnrichmentResult = {
  referencePhoto: null,
  referenceCredit: null,
  referenceLicense: null,
  referenceDisplayPath: null,
  referenceThumbPath: null,
  description: null,
  descriptionCredit: null,
  descriptionSourceUrl: null,
  habitatDescription: null,
  gallery: [],
};

describe.skipIf(!url)("persistEnrichment photo_withheld", async () => {
  const db = new pg.Pool({ connectionString: url });
  const { persistEnrichment } = await import("./lazyEnrich.js");
  const { pool } = await import("../db.js");

  afterAll(async () => {
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    await pool.end();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 8880001, 'Zzenrich withheldus', 'aves')`,
      [SPECIES],
    );
  });

  const withheld = async () =>
    (await db.query<{ photo_withheld: boolean }>(`SELECT photo_withheld FROM species WHERE id = $1`, [SPECIES])).rows[0]
      .photo_withheld;

  it("marks a species whose iNaturalist photos can't be published, and clears the mark once one can", async () => {
    await persistEnrichment(SPECIES, { ...empty, photoWithheld: true });
    expect(await withheld()).toBe(true);

    await persistEnrichment(SPECIES, { ...empty, photoWithheld: false });
    expect(await withheld()).toBe(false);
  });

  it("keeps the mark when the enrichment couldn't tell (personal viewing, or iNaturalist unreachable)", async () => {
    await db.query(`UPDATE species SET photo_withheld = true WHERE id = $1`, [SPECIES]);
    await persistEnrichment(SPECIES, empty);
    expect(await withheld()).toBe(true);
  });

  it("never marks a species that already has a photo", async () => {
    await db.query(
      `UPDATE species SET reference_photo = 'https://example.org/p.jpg', reference_credit = 'Someone', reference_license = 'cc-by'
       WHERE id = $1`,
      [SPECIES],
    );
    await persistEnrichment(SPECIES, { ...empty, photoWithheld: true });
    expect(await withheld()).toBe(false);
  });
  const checkedAt = async () =>
    (await db.query<{ description_checked_at: Date | null; enriched_at: Date | null }>(
      `SELECT description_checked_at, enriched_at FROM species WHERE id = $1`,
      [SPECIES],
    )).rows[0];

  it("stamps description_checked_at only when a text source was actually read (migration 128)", async () => {
    await persistEnrichment(SPECIES, { ...empty, descriptionChecked: false });
    let row = await checkedAt();
    expect(row.enriched_at).not.toBeNull();
    expect(row.description_checked_at).toBeNull();

    await persistEnrichment(SPECIES, { ...empty, descriptionChecked: true });
    row = await checkedAt();
    expect(row.description_checked_at).not.toBeNull();
  });

  it("an unchecked enrichment leaves an earlier text stamp alone", async () => {
    await db.query(`UPDATE species SET description_checked_at = '2020-01-01' WHERE id = $1`, [SPECIES]);
    await persistEnrichment(SPECIES, empty);
    expect((await checkedAt()).description_checked_at?.toISOString()).toBe(new Date("2020-01-01").toISOString());
  });
});
