// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database, never the
// maintainer database: the policy works across every species. Each test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPhotoLicensePolicy, applyPhotoLicensePolicyWith, assertPhotosPublishable } from "./photoLicensePolicy.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("applyPhotoLicensePolicyWith", () => {
  const db = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;

  beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await db.end();
  });

  async function species(name: string, license: string | null): Promise<string> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, reference_photo, reference_credit,
                            reference_license, reference_display_path)
       VALUES ((random() * 1e9)::int, $1, $1, 'aves', 'https://example.org/' || $1 || '.jpg', 'Someone', $2, '/x/' || $1 || '.webp')
       RETURNING id`,
      [name, license],
    );
    return res.rows[0].id;
  }

  async function galleryPhoto(speciesId: string, url: string, license: string | null, sortOrder: number) {
    await client.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path)
       VALUES ($1, $2, 'Photographer', $3, $4, '/x/gallery.webp')`,
      [speciesId, url, license, sortOrder],
    );
  }

  it("swaps in a publishable gallery photo, drops the stale main vector, and removes the rest", async () => {
    const id = await species("Testus swapus", "all-rights-reserved");
    await galleryPhoto(id, "https://example.org/arr.jpg", "all-rights-reserved", 0);
    await galleryPhoto(id, "https://example.org/open.jpg", "cc-by", 1);
    await client.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, '{0.1}', 'test')`,
      [id],
    );
    await client.query(
      `INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version) VALUES ($1, '{0.1}', 'test')`,
      [id],
    );

    // Left over from an earlier run that had cleared it.
    await client.query(`UPDATE species SET photo_withheld = true WHERE id = $1`, [id]);

    await applyPhotoLicensePolicyWith(client);

    const main = await client.query(
      `SELECT reference_photo, reference_license, photo_withheld FROM species WHERE id = $1`,
      [id],
    );
    expect(main.rows[0]).toEqual({
      reference_photo: "https://example.org/open.jpg",
      reference_license: "cc-by",
      photo_withheld: false,
    });
    const gallery = await client.query(`SELECT photo_url FROM species_reference_photos WHERE species_id = $1`, [id]);
    expect(gallery.rows).toEqual([]);
    const vectors = await client.query(`SELECT 1 FROM species_reference_embeddings WHERE species_id = $1`, [id]);
    expect(vectors.rowCount).toBe(0);
    const idVectors = await client.query(`SELECT 1 FROM id_model_reference_embeddings WHERE species_id = $1`, [id]);
    expect(idVectors.rowCount).toBe(0);
  });

  it("clears the main photo when nothing publishable is left, and keeps publishable species as they are", async () => {
    const bare = await species("Testus bareus", "all-rights-reserved");
    const fine = await species("Testus fineus", "cc-by-sa");
    // A species that once had nothing publishable and has a publishable photo now.
    await client.query(`UPDATE species SET photo_withheld = true WHERE id = $1`, [fine]);

    await applyPhotoLicensePolicyWith(client);

    const rows = await client.query(
      `SELECT id, reference_photo, reference_display_path, photo_withheld FROM species WHERE id = ANY($1)`,
      [[bare, fine]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(bare)).toMatchObject({ reference_photo: null, reference_display_path: null, photo_withheld: true });
    expect(byId.get(fine)).toMatchObject({
      reference_photo: "https://example.org/Testus fineus.jpg",
      photo_withheld: false,
    });
  });

  it("keeps the withheld mark of a species already left photoless by an earlier run", async () => {
    const earlier = await species("Testus earlierus", "all-rights-reserved");
    await applyPhotoLicensePolicyWith(client);

    await applyPhotoLicensePolicyWith(client);

    const row = await client.query(`SELECT reference_photo, photo_withheld FROM species WHERE id = $1`, [earlier]);
    expect(row.rows[0]).toEqual({ reference_photo: null, photo_withheld: true });
  });

  // The checks below look at every species, so each starts from an empty catalog inside the
  // test's transaction (rolled back afterwards like everything else here).
  async function emptyCatalog() {
    await client.query(`DELETE FROM species_reference_photos`);
    await client.query(`UPDATE species SET reference_photo = NULL, reference_license = NULL`);
  }
  // assertPhotosPublishable only queries, so the transaction's client stands in for the pool.
  const asPool = () => client as unknown as pg.Pool;

  describe("assertPhotosPublishable", () => {
    it("passes when every main and gallery photo can be published", async () => {
      await emptyCatalog();
      const id = await species("Testus openus", "cc-by");
      await galleryPhoto(id, "https://example.org/pd.jpg", "pd", 0);
      await expect(assertPhotosPublishable(asPool())).resolves.toBeUndefined();
    });

    it("counts every unpublishable main and gallery photo", async () => {
      await emptyCatalog();
      const id = await species("Testus closedus", "copyright");
      await galleryPhoto(id, "https://example.org/arr.jpg", "all-rights-reserved", 0);
      await galleryPhoto(id, "https://example.org/ok.jpg", "cc0", 1);
      await expect(assertPhotosPublishable(asPool())).rejects.toThrow(
        /^2 photo\(s\) in the database have a license that can't be published\. Run `npm run apply-photo-licenses -w data-pipeline`/,
      );
    });

    it("ignores the license of a species with no main photo", async () => {
      await emptyCatalog();
      const id = await species("Testus nophotous", "all-rights-reserved");
      await client.query(`UPDATE species SET reference_photo = NULL WHERE id = $1`, [id]);
      await expect(assertPhotosPublishable(asPool())).resolves.toBeUndefined();
    });
  });

  describe("applyPhotoLicensePolicy", () => {
    // Its BEGIN/COMMIT/ROLLBACK become a savepoint inside the test's transaction, so it really
    // commits or rolls back its own work without committing anything to the database.
    function poolOnTestTransaction(failOn?: RegExp) {
      const calls: string[] = [];
      let released = 0;
      const toSavepoint: Record<string, string> = {
        BEGIN: "SAVEPOINT policy",
        COMMIT: "RELEASE SAVEPOINT policy",
        ROLLBACK: "ROLLBACK TO SAVEPOINT policy",
      };
      const fake = {
        query: async (sql: string, params?: unknown[]) => {
          calls.push(sql.split(/\s/)[0]);
          if (failOn?.test(sql)) throw new Error("simulated failure");
          return client.query(toSavepoint[sql] ?? sql, params);
        },
        release: () => void released++,
      };
      const pool = { connect: async () => fake } as unknown as pg.Pool;
      return { pool, calls, released: () => released };
    }

    it("commits the whole fix in one transaction, reports the counts and returns the connection", async () => {
      await emptyCatalog();
      const swap = await species("Testus swapus", "all-rights-reserved");
      await galleryPhoto(swap, "https://example.org/open.jpg", "cc-by", 0);
      await galleryPhoto(swap, "https://example.org/nc.jpg", "copyright", 1);
      await species("Testus bareus", "all-rights-reserved");
      const { pool, calls, released } = poolOnTestTransaction();
      const logged: string[] = [];

      const plan = await applyPhotoLicensePolicy(pool, (m) => logged.push(m));

      expect(plan.promote).toHaveLength(1);
      expect(calls[0]).toBe("BEGIN");
      expect(calls.at(-1)).toBe("COMMIT");
      expect(released()).toBe(1);
      expect(logged).toEqual([
        "1 main photo(s) replaced with a publishable gallery photo, 1 cleared, 1 gallery photo(s) removed",
      ]);
      await expect(assertPhotosPublishable(asPool())).resolves.toBeUndefined();
    });

    it("rolls everything back when a step fails, and still returns the connection", async () => {
      await emptyCatalog();
      const swap = await species("Testus swapus", "all-rights-reserved");
      await galleryPhoto(swap, "https://example.org/open.jpg", "cc-by", 0);
      const { pool, calls, released } = poolOnTestTransaction(/^DELETE FROM species_reference_photos/);

      await expect(applyPhotoLicensePolicy(pool, () => {})).rejects.toThrow("simulated failure");

      expect(calls.at(-1)).toBe("ROLLBACK");
      expect(released()).toBe(1);
      const main = await client.query(`SELECT reference_photo FROM species WHERE id = $1`, [swap]);
      expect(main.rows[0].reference_photo).toBe("https://example.org/Testus swapus.jpg");
    });
  });
});
