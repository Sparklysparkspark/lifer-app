// Rolls up each country's own top-level region_species row directly from its already-computed
// PROVINCE-level rows (compute-provinces-bulk.ts) — no live GBIF calls, no rate-limit risk,
// just aggregating data this app already trusts. Replaces the old dependency on
// computeRegionOccurrences (regions/routes.ts) for country-level rows, which only ever
// recomputes a region that's NEVER been computed before (occurrence_computed_at IS NULL) — once
// a country's own row got a value there, its country-level checklist was permanently frozen at
// whatever it looked like that one time, even as its provinces kept getting refreshed. Confirmed
// live: Canada's own country-level row had real aves/actinopterygii data but ZERO mammalia,
// despite 152+ real non-vagrant Canadian mammal species sitting in its provinces' own rows.
//
// Usage: npx tsx src/scripts/aggregate-country-from-provinces.ts <Country Name>
//    or: npx tsx src/scripts/aggregate-country-from-provinces.ts --all
import { pool } from "../db.js";

const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];

interface ProvinceRow {
  species_id: string;
  local_frequency: string | null;
  is_vagrant: boolean;
  local_tier: string | null;
  weekly_frequency: number[] | null;
}

async function aggregateCountry(countryId: string, countryName: string): Promise<void> {
  const res = await pool.query<ProvinceRow>(
    `SELECT rs.species_id, rs.local_frequency, rs.is_vagrant, rs.local_tier, rs.weekly_frequency
     FROM region_species rs
     WHERE rs.region_id IN (SELECT id FROM regions WHERE parent_id = $1)`,
    [countryId],
  );
  if (res.rows.length === 0) return;

  const bySpecies = new Map<
    string,
    { frequency: number; isVagrant: boolean; bestTierRank: number | null; weeklyFrequency: number[] | null }
  >();
  for (const row of res.rows) {
    let entry = bySpecies.get(row.species_id);
    if (!entry) {
      entry = { frequency: 0, isVagrant: true, bestTierRank: null, weeklyFrequency: null };
      bySpecies.set(row.species_id, entry);
    }
    entry.frequency += Number(row.local_frequency ?? 0);
    // A species genuinely resident in even ONE province isn't a country-wide vagrant, even if
    // it's merely a vagrant visitor elsewhere in the same country.
    if (!row.is_vagrant) entry.isVagrant = false;
    if (row.local_tier) {
      const rank = TIER_ORDER.indexOf(row.local_tier);
      // Lower rank = rarer; a HIGHER rank (more common) anywhere in the country is the more
      // representative "can I realistically find this here" signal at the country level.
      if (rank !== -1 && (entry.bestTierRank === null || rank > entry.bestTierRank)) entry.bestTierRank = rank;
    }
    if (row.weekly_frequency) {
      if (!entry.weeklyFrequency) entry.weeklyFrequency = new Array(52).fill(0);
      for (let i = 0; i < 52; i++) entry.weeklyFrequency[i] += row.weekly_frequency[i] ?? 0;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM region_species WHERE region_id = $1`, [countryId]);
    let written = 0;
    for (const [speciesId, entry] of bySpecies) {
      await client.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant, local_tier, weekly_frequency)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          countryId,
          speciesId,
          entry.frequency,
          entry.isVagrant,
          entry.bestTierRank !== null ? TIER_ORDER[entry.bestTierRank] : null,
          entry.weeklyFrequency,
        ],
      );
      written++;
    }
    await client.query("COMMIT");
    console.log(`[aggregate-country-from-provinces] ${countryName}: rolled up ${written} species from provinces`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx src/scripts/aggregate-country-from-provinces.ts <Country Name> | --all");
    process.exit(1);
  }

  if (arg === "--all") {
    const countries = await pool.query<{ id: string; name: string }>(
      `SELECT country.id, country.name FROM regions country
       JOIN regions cont ON cont.id = country.parent_id
       JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
       WHERE EXISTS (SELECT 1 FROM regions p WHERE p.parent_id = country.id)`,
    );
    for (const c of countries.rows) await aggregateCountry(c.id, c.name);
  } else {
    const res = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [arg]);
    if (res.rows.length === 0) {
      console.error(`No region named "${arg}"`);
      process.exit(1);
    }
    await aggregateCountry(res.rows[0].id, arg);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
