// Integration test (real Postgres required — same local DB as `npm run migrate`) for a
// regression where reloading the mammal seed silently wiped
// elusiveness_score/composite/tier for every mammal, because build-seed-mammals.ts never
// computes elusiveness and the old UPSERT applied EXCLUDED unconditionally. Runs inside a
// transaction that's always rolled back, so it never touches real data.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { upsertSpeciesRarity } from "./load-seed.js";

let client: PoolClient;
let speciesId: string;

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  const res = await client.query(
    `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class)
     VALUES (999999999, 'Testus regressionus', 'Test Species', 'mammalia')
     RETURNING id`,
  );
  speciesId = res.rows[0].id;
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("upsertSpeciesRarity", () => {
  it("does not clobber an already-computed elusiveness_score/composite/tier when the incoming seed has none", async () => {
    // First write: simulates apply-rarity-phase4.ts having already folded in a real
    // elusiveness score (a "phase 4" state) directly via raw SQL, since upsertSpeciesRarity
    // itself never accepts a phase-4 write path (only load-seed's phase-1-only inputs) — this
    // mirrors how the real column actually gets its elusiveness value in production.
    await client.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, elusiveness_score, composite, tier)
       VALUES ($1, 0.5, 0.5, 0.66, 0.6, 'rare')`,
      [speciesId],
    );

    // Second write: a reseed from build-seed-mammals.ts, which always sends
    // elusivenessScore: null and a Phase-1-only (weaker) composite/tier.
    await upsertSpeciesRarity(client, speciesId, {
      rangeScore: 0.4,
      abundanceScore: 0.1,
      elusivenessScore: null,
      composite: 0.28,
      tier: "common",
    });

    const res = await client.query(`SELECT elusiveness_score, composite, tier, range_score, abundance_score FROM species_rarity WHERE species_id = $1`, [
      speciesId,
    ]);
    const row = res.rows[0];
    // The elusiveness-derived fields must survive the reseed untouched.
    expect(Number(row.elusiveness_score)).toBeCloseTo(0.66);
    expect(Number(row.composite)).toBeCloseTo(0.6);
    expect(row.tier).toBe("rare");
    // range_score/abundance_score DO refresh on every reseed — they come from Phase 1 data
    // (range size, IUCN status) that's legitimate to re-sync each time.
    expect(Number(row.range_score)).toBeCloseTo(0.4);
    expect(Number(row.abundance_score)).toBeCloseTo(0.1);
  });

  it("uses the seed's own Phase-1 values as a placeholder for a brand-new species with no prior row", async () => {
    await upsertSpeciesRarity(client, speciesId, {
      rangeScore: 0.3,
      abundanceScore: 0.2,
      elusivenessScore: null,
      composite: 0.25,
      tier: "uncommon",
    });

    const res = await client.query(`SELECT elusiveness_score, composite, tier FROM species_rarity WHERE species_id = $1`, [speciesId]);
    expect(res.rows[0].elusiveness_score).toBeNull();
    expect(Number(res.rows[0].composite)).toBeCloseTo(0.25);
    expect(res.rows[0].tier).toBe("uncommon");
  });

  it("DOES overwrite elusiveness/composite/tier when the incoming seed actually carries elusiveness data", async () => {
    await client.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, elusiveness_score, composite, tier)
       VALUES ($1, 0.5, 0.5, 0.66, 0.6, 'rare')`,
      [speciesId],
    );

    await upsertSpeciesRarity(client, speciesId, {
      rangeScore: 0.4,
      abundanceScore: 0.1,
      elusivenessScore: 0.9,
      composite: 0.7,
      tier: "epic",
    });

    const res = await client.query(`SELECT elusiveness_score, composite, tier FROM species_rarity WHERE species_id = $1`, [speciesId]);
    expect(Number(res.rows[0].elusiveness_score)).toBeCloseTo(0.9);
    expect(Number(res.rows[0].composite)).toBeCloseTo(0.7);
    expect(res.rows[0].tier).toBe("epic");
  });
});
