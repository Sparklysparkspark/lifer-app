// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Each test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveOccurrenceStats, selectOccurrenceTargets, stampOccurrenceChecked } from "./occurrenceStatsStore.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("occurrence stats store", () => {
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

  async function species(
    name: string,
    opts: {
      count?: number | null;
      year?: number | null;
      checkedDaysAgo?: number | null;
      order?: string | null;
      traits?: boolean;
    } = {},
  ) {
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO species (gbif_key, scientific_name, taxon_class, taxon_order)
         VALUES (900000000 + (random() * 1e8)::int, $1, 'marine_mollusks', $2) RETURNING id`,
        [name, opts.order ?? null],
      )
    ).rows[0].id;
    if (opts.traits !== false) {
      await client.query(
        `INSERT INTO species_traits (species_id, occurrence_count, last_occurrence_year, occurrence_checked_at, source_attribution)
         VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END, 'test')`,
        [id, opts.count ?? null, opts.year ?? null, opts.checkedDaysAgo ?? null],
      );
    }
    return id;
  }

  const traits = async (id: string) =>
    (
      await client.query<{ occurrence_count: number | null; last_occurrence_year: number | null; checked: boolean }>(
        `SELECT occurrence_count, last_occurrence_year, occurrence_checked_at > now() - interval '1 minute' AS checked
           FROM species_traits WHERE species_id = $1`,
        [id],
      )
    ).rows[0];

  const names = async (scope: Parameters<typeof selectOccurrenceTargets>[1]) =>
    (await selectOccurrenceTargets(client, scope)).map((r) => r.scientific_name).filter((n) => n.startsWith("Zzocc"));

  it("picks missing species not checked recently; a full run takes stale ones too", async () => {
    await species("Zzocc never");
    await species("Zzocc failed long ago", { checkedDaysAgo: 120 });
    await species("Zzocc no records, checked recently", { count: 0, checkedDaysAgo: 3 });
    await species("Zzocc missing, checked recently", { checkedDaysAgo: 3 });
    await species("Zzocc has stats, stale", { count: 50, year: 2020, checkedDaysAgo: 200 });
    await species("Zzocc has stats, never stamped", { count: 50, year: 2020 });
    await species("Zzocc no traits row", { traits: false });

    expect(await names({ onlyMissing: true, recheckAfterDays: 90 })).toEqual(["Zzocc failed long ago", "Zzocc never"]);
    expect(await names({ onlyMissing: true, recheckAfterDays: 0 })).toEqual([
      "Zzocc failed long ago",
      "Zzocc missing, checked recently",
      "Zzocc never",
    ]);
    expect(await names({ onlyMissing: false, recheckAfterDays: 90 })).toEqual([
      "Zzocc failed long ago",
      "Zzocc has stats, never stamped",
      "Zzocc has stats, stale",
      "Zzocc never",
    ]);
  });

  it("groups by order, falling back to the catalog group", async () => {
    await species("Zzocc b", { order: "Neogastropoda" });
    await species("Zzocc a", {});
    const rows = (await selectOccurrenceTargets(client, { onlyMissing: true, recheckAfterDays: 0 })).filter((r) =>
      r.scientific_name.startsWith("Zzocc"),
    );
    expect(rows.map((r) => [r.scientific_name, r.group_name]).sort()).toEqual([
      ["Zzocc a", "marine_mollusks"],
      ["Zzocc b", "Neogastropoda"],
    ]);
    expect(typeof rows[0].gbif_key).toBe("number");
  });

  it("saves stats with a stamp, including no records, so the next missing-only run skips them", async () => {
    const common = await species("Zzocc common");
    const none = await species("Zzocc nothing");
    const stale = await species("Zzocc stale", { count: 7, year: 1990, checkedDaysAgo: 400 });
    await saveOccurrenceStats(client, [
      { speciesId: common, stats: { count: 12345, lastYear: 2026 } },
      { speciesId: none, stats: { count: 0, lastYear: null } },
      { speciesId: stale, stats: { count: 9, lastYear: null } },
    ]);
    expect(await traits(common)).toEqual({ occurrence_count: 12345, last_occurrence_year: 2026, checked: true });
    expect(await traits(none)).toEqual({ occurrence_count: 0, last_occurrence_year: null, checked: true });
    // A newer answer replaces an old year with none.
    expect(await traits(stale)).toEqual({ occurrence_count: 9, last_occurrence_year: null, checked: true });
    expect(await names({ onlyMissing: true, recheckAfterDays: 90 })).toEqual([]);
    expect(await names({ onlyMissing: false, recheckAfterDays: 90 })).toEqual([]);
  });

  it("stamps a failed species without touching its stats", async () => {
    const failed = await species("Zzocc rejected");
    const kept = await species("Zzocc kept", { count: 3, year: 1888, checkedDaysAgo: 400 });
    await stampOccurrenceChecked(client, [failed, kept]);
    expect(await traits(failed)).toEqual({ occurrence_count: null, last_occurrence_year: null, checked: true });
    expect(await traits(kept)).toEqual({ occurrence_count: 3, last_occurrence_year: 1888, checked: true });
    expect(await names({ onlyMissing: true, recheckAfterDays: 90 })).toEqual([]);
    await saveOccurrenceStats(client, []);
    await stampOccurrenceChecked(client, []);
  });
});
