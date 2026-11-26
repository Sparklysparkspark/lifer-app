// Loads the real catalog seed into a freshly migrated, empty database the way a new install does,
// so a migration that no longer fits the published seed fails CI instead of first launch. Needs
// the seed in catalog-seed/ (node apps/api/scripts/fetch-catalog-seed.js) and a database nothing
// else uses:
//   CATALOG_SEED_LOAD=1 TEST_DATABASE_URL=postgres://.../fresh npx vitest run catalogSeedLoad
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool as appPool } from "@lifer/core/db.js";
import {
  applyCatalogSeedFile,
  getAppliedCatalogVersion,
  seedCatalogIfEmpty,
  verifiedBundledSeed,
} from "./catalogSeedUpdate.js";
import { whenSpeciesSearchReady } from "./search.js";

const url = process.env.TEST_DATABASE_URL;
// Local first loads take about 21 s; generous for slower CI runners.
const BUDGET_MS = 90_000;
const noProgress = { update: () => {}, throwIfCancelled: () => {} };

describe.skipIf(!url || !process.env.CATALOG_SEED_LOAD)("bundled catalog seed (fresh database)", () => {
  const pool = new pg.Pool({ connectionString: url });
  // Ending the pool waits for the background work a first load starts, which can outlast 10 s on CI.
  afterAll(async () => {
    await pool.end();
    await appPool.end();
  }, 180_000);

  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const indexes = async () =>
    (
      await pool.query<{ name: string }>(
        `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
      )
    ).rows.map((r) => r.name);

  it(
    "fills an empty catalog within budget, keeps every index, and a re-apply changes nothing",
    { timeout: 600_000 },
    async () => {
      const bundled = await verifiedBundledSeed();
      expect(bundled, "no seed in catalog-seed/").not.toBeNull();
      expect(await count("species")).toBe(0);
      const before = await indexes();

      const started = Date.now();
      const result = await seedCatalogIfEmpty(appPool);
      const elapsed = Date.now() - started;
      console.log(`[catalog seed load] first load took ${(elapsed / 1000).toFixed(1)} s`);
      expect(result.seeded).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS);

      expect(await count("species")).toBeGreaterThan(0);
      expect(await count("regions")).toBeGreaterThan(0);
      expect(await count("region_species")).toBeGreaterThan(0);
      expect(await getAppliedCatalogVersion(pool)).toBe(bundled!.version);
      expect(await indexes()).toEqual(before);
      await whenSpeciesSearchReady();
      expect(await count("species_search_names")).toBeGreaterThan(0);

      // An update over the filled catalog takes the merge path; the same seed has nothing to change.
      const checklist = await count("region_species");
      const merged = await applyCatalogSeedFile(appPool, bundled!.path, bundled!.version, noProgress);
      expect(merged.region_species).toBe(0);
      expect(merged.region_speciesRemoved).toBe(0);
      expect(await count("region_species")).toBe(checklist);
    },
  );
});
