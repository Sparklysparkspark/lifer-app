// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The iNaturalist
// responses are synthetic rows in inat_response_cache; lookups are faked, nothing goes online.
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const REGION = "Zzbackfill Land";
const id = (n: number) => `66666666-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const S = {
  searchUnpublishable: id(1),
  detailUnpublishable: id(2),
  publishable: id(3),
  noPhoto: id(4),
  uncached: id(5),
  unlisted: id(6),
  hasPhoto: id(7),
};
const ALL = Object.values(S);
const name = (speciesId: string) =>
  `Zzbackfill ${Object.entries(S)
    .find(([, v]) => v === speciesId)![0]
    .toLowerCase()}`;
const TAXON_BASE = 990_000;

describe.skipIf(!url)("backfillPhotoWithheld", async () => {
  const db = new pg.Pool({ connectionString: url });
  const { backfillPhotoWithheld, classifyPhotoEvidence } = await import("./photoWithheldBackfill.js");
  const { inatTaxonSearchUrl, inatTaxonUrl } = await import("@lifer/core/species/lazyEnrich.js");
  const { pool } = await import("@lifer/core/db.js");

  const photo = (license: string | null) => ({ license_code: license, medium_url: "https://example.org/p.jpg" });
  const search = (n: string, taxonId: number, defaultPhoto: object | null) =>
    JSON.stringify({
      results: [
        { id: taxonId + 1, name: `${n} similis`, default_photo: photo("cc0") },
        { id: taxonId, name: n, default_photo: defaultPhoto },
      ],
    });
  const record = (taxonId: number, defaultPhoto: object | null, photos: object[]) =>
    JSON.stringify({
      results: [{ id: taxonId, default_photo: defaultPhoto, taxon_photos: photos.map((p) => ({ photo: p })) }],
    });

  async function cache(cacheUrl: string, response: string) {
    await db.query(
      `INSERT INTO inat_response_cache (url, response) VALUES ($1, $2) ON CONFLICT (url) DO UPDATE SET response = EXCLUDED.response`,
      [cacheUrl, response],
    );
  }

  async function cleanUp() {
    await db.query(`DELETE FROM regions WHERE name = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.query(`DELETE FROM inat_response_cache WHERE url LIKE '%Zzbackfill%' OR url ~ '/taxa/99000[0-9]$'`);
  }

  afterAll(async () => {
    await cleanUp();
    await db.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanUp();
    for (const [i, speciesId] of ALL.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, inat_taxon_id) VALUES ($1, $2, $3, 'aves', $4)`,
        [speciesId, 6_660_000 + i, name(speciesId), TAXON_BASE + i],
      );
    }
    await db.query(
      `UPDATE species SET reference_photo = 'https://example.org/own.jpg', reference_credit = 'Me', reference_license = 'cc-by' WHERE id = $1`,
      [S.hasPhoto],
    );
    const region = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [REGION]))
      .rows[0].id;
    for (const speciesId of ALL.filter((s) => s !== S.unlisted)) {
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [region, speciesId]);
    }
    const taxonId = (speciesId: string) => TAXON_BASE + ALL.indexOf(speciesId);
    // Only the search is cached, and its default photo is "all rights reserved".
    await cache(
      inatTaxonSearchUrl(name(S.searchUnpublishable)),
      search(name(S.searchUnpublishable), taxonId(S.searchUnpublishable), photo(null)),
    );
    // The search has no default photo flagged; the taxon record has only unpublishable photos.
    await cache(
      inatTaxonSearchUrl(name(S.detailUnpublishable)),
      search(name(S.detailUnpublishable), taxonId(S.detailUnpublishable), null),
    );
    await cache(
      inatTaxonUrl(taxonId(S.detailUnpublishable)),
      record(taxonId(S.detailUnpublishable), null, [photo("gfdl"), photo(null)]),
    );
    await cache(inatTaxonUrl(taxonId(S.publishable)), record(taxonId(S.publishable), photo(null), [photo("cc-by-nc")]));
    await cache(inatTaxonUrl(taxonId(S.noPhoto)), record(taxonId(S.noPhoto), null, []));
    for (const s of [S.unlisted, S.hasPhoto])
      await cache(inatTaxonUrl(taxonId(s)), record(taxonId(s), photo(null), []));
  });

  const withheld = async () =>
    (
      await db.query<{ id: string }>(`SELECT id FROM species WHERE id = ANY($1) AND photo_withheld ORDER BY id`, [ALL])
    ).rows.map((r) => r.id);
  const noLookups = vi.fn(async () => ({ rateLimited: false }));

  it("marks listed photoless species whose cached photos are all unpublishable, without going online", async () => {
    const result = await backfillPhotoWithheld(db, { network: false, dryRun: false, lookup: noLookups });

    expect(await withheld()).toEqual([S.searchUnpublishable, S.detailUnpublishable].sort());
    expect(noLookups).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      withheld: 2,
      marked: 2,
      publishable: 1,
      none: 1,
      lookedUp: 0,
      stoppedByRateLimit: false,
    });
    expect(result.unknown).toBeGreaterThanOrEqual(1);
  });

  it("changes nothing in a dry run", async () => {
    const result = await backfillPhotoWithheld(db, { network: false, dryRun: true, lookup: noLookups });

    expect(result.withheld).toBe(2);
    expect(result.marked).toBe(0);
    expect(await withheld()).toEqual([]);
  });

  it("looks up only species with no cached answer, then decides from what the lookup cached", async () => {
    const looked: string[] = [];
    const lookup = vi.fn(async (species: { scientific_name: string; inat_taxon_id: number | null }) => {
      looked.push(species.scientific_name);
      if (species.scientific_name === name(S.uncached)) {
        await cache(inatTaxonUrl(species.inat_taxon_id!), record(species.inat_taxon_id!, photo("copyright"), []));
      }
      return { rateLimited: false };
    });

    await backfillPhotoWithheld(db, { network: true, dryRun: false, lookup });

    expect(looked.filter((n) => n.startsWith("Zzbackfill"))).toEqual([name(S.uncached)]);
    expect(await withheld()).toContain(S.uncached);
  });

  it("stops looking up once iNaturalist keeps rate-limiting", async () => {
    // Enough unknown species to fill the breaker's window.
    const extra = Array.from(
      { length: 45 },
      (_, i) => `66666666-1111-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    );
    const region = (await db.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [REGION])).rows[0].id;
    try {
      for (const [i, speciesId] of extra.entries()) {
        await db.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves')`, [
          speciesId,
          6_661_000 + i,
          `Zzbackfill extra${i}`,
        ]);
        await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [region, speciesId]);
      }
      const lookup = vi.fn(async () => ({ rateLimited: true }));

      const result = await backfillPhotoWithheld(db, { network: true, dryRun: false, lookup });

      expect(result.stoppedByRateLimit).toBe(true);
      expect(lookup.mock.calls.length).toBeLessThan(extra.length);
      // What the cache already settled is still written.
      expect(result.marked).toBe(2);
    } finally {
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [extra]);
    }
  });

  it("classifies from the search's exact match only, never a similar name", () => {
    const response = JSON.stringify({ results: [{ id: 1, name: "Testus similis", default_photo: photo(null) }] });
    expect(classifyPhotoEvidence("Testus testus", response, [])).toBe("unknown");
    expect(classifyPhotoEvidence("Testus similis", response, [])).toBe("withheld");
    expect(classifyPhotoEvidence("Testus similis", "not json", [undefined])).toBe("unknown");
  });
});
