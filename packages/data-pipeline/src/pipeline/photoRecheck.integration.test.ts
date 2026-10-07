// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Each test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectSpeciesToRecheck } from "./photoRecheck.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("selectSpeciesToRecheck", () => {
  const db = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;
  let regionId: string;

  beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
    regionId = (await client.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Zzrecheckland') RETURNING id`))
      .rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await db.end();
  });

  async function species(
    name: string,
    opts: { photo?: boolean; checkedDaysAgo?: number; listed?: boolean; enriched?: boolean },
  ) {
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO species (gbif_key, scientific_name, taxon_class, enriched_at, reference_photo, reference_credit,
                              reference_license, photo_checked_at)
         VALUES ((random() * 1e9)::int, $1, 'aves', CASE WHEN $2 THEN now() END,
                 CASE WHEN $3 THEN 'https://example.org/p.jpg' END, CASE WHEN $3 THEN 'Someone' END,
                 CASE WHEN $3 THEN 'cc-by' END, CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END)
         RETURNING id`,
        [name, opts.enriched ?? true, opts.photo ?? false, opts.checkedDaysAgo ?? null],
      )
    ).rows[0].id;
    if (opts.listed)
      await client.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [regionId, id]);
    return id;
  }

  const names = async (scope: Parameters<typeof selectSpeciesToRecheck>[1]) =>
    (await selectSpeciesToRecheck(client, scope)).map((r) => r.scientific_name).filter((n) => n.startsWith("Zzre"));

  it("picks enriched photoless species not checked recently", async () => {
    await species("Zzre never", {});
    await species("Zzre long ago", { checkedDaysAgo: 120 });
    await species("Zzre recently", { checkedDaysAgo: 10 });
    await species("Zzre has photo", { photo: true });
    await species("Zzre not enriched", { enriched: false });

    expect(await names({ countries: null, listedOnly: false, recheckAfterDays: 90 })).toEqual([
      "Zzre long ago",
      "Zzre never",
    ]);
    expect(await names({ countries: null, listedOnly: false, recheckAfterDays: 5 })).toEqual([
      "Zzre long ago",
      "Zzre never",
      "Zzre recently",
    ]);
  });

  it("limits to listed species, or to named countries", async () => {
    await species("Zzre listed", { listed: true });
    await species("Zzre unlisted", {});

    expect(await names({ countries: null, listedOnly: true, recheckAfterDays: 90 })).toEqual(["Zzre listed"]);
    expect(await names({ countries: ["Zzrecheckland"], listedOnly: false, recheckAfterDays: 90 })).toEqual([
      "Zzre listed",
    ]);
    expect(await names({ countries: ["Elsewhere"], listedOnly: false, recheckAfterDays: 90 })).toEqual([]);
  });
});
