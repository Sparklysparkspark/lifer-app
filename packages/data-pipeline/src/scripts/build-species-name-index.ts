// Resolves species names in a GBIF bulk occurrence download back to catalog species rows via
// GBIF's species/match endpoint, and records every variant as a synonym. Bulk records carry each
// dataset's own taxonomy, which can differ from the GBIF backbone, so names are matched rather
// than walked from our own keys.
//
// A differing name is adopted as the new scientific_name (old one kept as a synonym) only when
// it clearly dominates the current name's record count across the whole dataset, so a single
// stray record can't rename a species.
//
// Usage: npx tsx src/scripts/build-species-name-index.ts --dir=<extracted GBIF download dir>
import { readdirSync, createReadStream } from "node:fs";
import readline from "node:readline";
import { pool } from "@lifer/core/db.js";
import { fetchWithRetry } from "@lifer/core/lib/fetchWithRetry.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";

const GBIF_MATCH_API = "https://api.gbif.org/v1/species/match";
// Kept modest to stay within GBIF's rate limits.
const CONCURRENCY = 5;
// A challenger name must clear an absolute floor AND beat the current name's count by a margin,
// so stray records or noise can't flip the name back and forth between runs.
const RENAME_MIN_RECORDS = 20;
const RENAME_MARGIN_MULTIPLIER = 3;

interface MatchResult {
  usageKey?: number;
  acceptedUsageKey?: number;
  status?: string;
}

async function resolveKeyForName(name: string): Promise<number | null> {
  const res = await fetchWithRetry(`${GBIF_MATCH_API}?name=${encodeURIComponent(name)}&strict=true`, {});
  if (!res.ok) throw new Error(`[species-name-index] match failed: ${res.status} ${res.statusText} (${name})`);
  const data = (await res.json()) as MatchResult;
  if (!data.usageKey) return null;
  if (data.status === "ACCEPTED") return data.usageKey;
  // Synonym or doubtful: acceptedUsageKey is GBIF's fully resolved current usage.
  return data.acceptedUsageKey ?? null;
}

async function distinctNamesFromDir(dir: string): Promise<Map<string, number>> {
  const fileName = readdirSync(dir).find((f) => f.endsWith(".csv") || f.endsWith(".tsv"));
  if (!fileName) throw new Error(`no .csv/.tsv found in ${dir}`);
  const counts = new Map<string, number>();
  const rl = readline.createInterface({ input: createReadStream(`${dir}/${fileName}`), crlfDelay: Infinity });
  let header: string[] | null = null;
  let speciesIdx = -1;
  let countIdx = -1;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      speciesIdx = header.indexOf("species");
      countIdx = header.indexOf("record_count");
      continue;
    }
    const name = cols[speciesIdx];
    if (!name) continue;
    const count = countIdx >= 0 ? Number(cols[countIdx]) || 0 : 1;
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return counts;
}

async function main() {
  const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
  if (!dirArg) throw new Error("usage: --dir=<extracted GBIF download dir>");

  console.log(`[species-name-index] scanning ${dirArg} for distinct species names...`);
  const nameCounts = await distinctNamesFromDir(dirArg);
  console.log(`[species-name-index] ${nameCounts.size} distinct species names in this dataset`);

  const speciesRes = await pool.query<{ id: string; gbif_key: string; scientific_name: string }>(
    `SELECT id, gbif_key, scientific_name FROM species WHERE gbif_key IS NOT NULL`,
  );
  const gbifKeyToSpeciesId = new Map<number, string>();
  const speciesIdToCurrentName = new Map<string, string>();
  const nameToSpeciesIdDirect = new Map<string, string>();
  for (const row of speciesRes.rows) {
    gbifKeyToSpeciesId.set(Number(row.gbif_key), row.id);
    speciesIdToCurrentName.set(row.id, row.scientific_name);
    nameToSpeciesIdDirect.set(row.scientific_name, row.id);
  }
  const synonymRes = await pool.query<{ species_id: string; synonym_name: string }>(
    `SELECT species_id, synonym_name FROM species_synonyms`,
  );
  for (const row of synonymRes.rows) nameToSpeciesIdDirect.set(row.synonym_name, row.species_id);

  const unresolved = [...nameCounts.keys()].filter((n) => !nameToSpeciesIdDirect.has(n));
  console.log(
    `[species-name-index] ${unresolved.length} names not already known (either as a scientific_name or a stored synonym), resolving via GBIF match`,
  );

  const nameToSpeciesId = new Map(nameToSpeciesIdDirect);
  let matched = 0;
  let noMatch = 0;
  let failed = 0;
  let done = 0;
  await mapWithConcurrency(unresolved, CONCURRENCY, async (name) => {
    try {
      const resolvedKey = await resolveKeyForName(name);
      const speciesId = resolvedKey != null ? gbifKeyToSpeciesId.get(resolvedKey) : undefined;
      if (speciesId) {
        nameToSpeciesId.set(name, speciesId);
        matched++;
      } else {
        noMatch++;
      }
    } catch (err) {
      failed++;
      console.error(`[species-name-index] FAILED "${name}":`, err);
    }
    done++;
    if (done % 1000 === 0) console.log(`[species-name-index] resolved ${done}/${unresolved.length}`);
  });
  console.log(
    `[species-name-index] match pass done: ${matched} matched an existing species, ${noMatch} matched no catalog species, ${failed} failed`,
  );

  // All name variants seen per species, so the rename decision compares them all.
  const variantsBySpeciesId = new Map<string, Array<{ name: string; count: number }>>();
  for (const [name, count] of nameCounts) {
    const speciesId = nameToSpeciesId.get(name);
    if (!speciesId) continue;
    if (!variantsBySpeciesId.has(speciesId)) variantsBySpeciesId.set(speciesId, []);
    variantsBySpeciesId.get(speciesId)!.push({ name, count });
  }

  let renamed = 0;
  let synonymsAdded = 0;
  let collided = 0;
  for (const [speciesId, variants] of variantsBySpeciesId) {
    if (variants.length < 2) continue; // Only one name variant seen at all: nothing to reconcile.
    const currentName = speciesIdToCurrentName.get(speciesId)!;
    const currentVariant = variants.find((v) => v.name === currentName);
    const currentCount = currentVariant?.count ?? 0;
    const challengers = variants.filter((v) => v.name !== currentName).sort((a, b) => b.count - a.count);
    const winner = challengers[0];

    const shouldRename = winner.count >= RENAME_MIN_RECORDS && winner.count >= currentCount * RENAME_MARGIN_MULTIPLIER;
    let renameApplied = false;
    if (shouldRename) {
      const collision = await pool.query(`SELECT 1 FROM species WHERE scientific_name = $1 AND id != $2`, [
        winner.name,
        speciesId,
      ]);
      if ((collision.rowCount ?? 0) > 0) {
        collided++;
        console.log(`[species-name-index] SKIP (name collision) ${currentName} -> ${winner.name}`);
      } else {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, $2) ON CONFLICT (synonym_name) DO NOTHING`,
            [speciesId, currentName],
          );
          await client.query(`UPDATE species SET scientific_name = $1 WHERE id = $2`, [winner.name, speciesId]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        renamed++;
        renameApplied = true;
        console.log(
          `[species-name-index] ${currentName} (${currentCount} records) -> ${winner.name} (${winner.count} records)`,
        );
      }
    }
    // Record every other variant as a synonym so future runs match it directly.
    const survivingName = renameApplied ? winner.name : currentName;
    for (const v of variants) {
      if (v.name === survivingName) continue;
      const res = await pool.query(
        `INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, $2) ON CONFLICT (synonym_name) DO NOTHING`,
        [speciesId, v.name],
      );
      if ((res.rowCount ?? 0) > 0) synonymsAdded++;
    }
  }

  console.log(
    `[species-name-index] done. ${renamed} renamed to a clearly-dominant current name, ${collided} skipped on name collision, ` +
      `${synonymsAdded} additional synonym names recorded for future matching.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
