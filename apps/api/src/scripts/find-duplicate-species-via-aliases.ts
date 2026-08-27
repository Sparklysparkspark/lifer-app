// Cross-checks every species' alias list (common_name_aliases, backfilled by
// backfill-common-names.ts) against every OTHER species' own primary common_name — an exact
// match is a strong signal of exactly the class of bug the Antennarius/Antennatus nummifer
// case was (GBIF's backbone listing the same real species twice under different genus
// placements, both independently "ACCEPTED"). Read-only: reports candidates for a human to
// confirm via real taxonomic sources (WoRMS/FishBase/Wikipedia) before merging — an alias
// match is suggestive, not proof, the way the nummifer case needed a real cross-check first.
import { pool } from "../db.js";

async function main() {
  const res = await pool.query<{
    id: string;
    scientific_name: string;
    common_name: string | null;
    common_name_aliases: string[] | null;
  }>(`SELECT id, scientific_name, common_name, common_name_aliases FROM species WHERE common_name IS NOT NULL`);

  const byPrimaryNameLower = new Map<string, Array<{ id: string; scientific_name: string; common_name: string }>>();
  for (const row of res.rows) {
    if (!row.common_name) continue;
    const key = row.common_name.toLowerCase();
    if (!byPrimaryNameLower.has(key)) byPrimaryNameLower.set(key, []);
    byPrimaryNameLower.get(key)!.push({ id: row.id, scientific_name: row.scientific_name, common_name: row.common_name });
  }

  const genusOf = (scientificName: string): string => scientificName.split(" ")[0];
  const epithetOf = (scientificName: string): string => scientificName.split(" ")[1] ?? "";

  // Plain Levenshtein edit distance — used only to separate "almost certainly the same name,
  // just a spelling/orthographic variant" (buettikoferi/buttikoferi, ride/ridei,
  // pumalio/pumilio, travers/traversii — all confirmed real cases below) from "same genus,
  // genuinely different species, coincidentally sharing a common congener-style vernacular
  // name" (most of the ~1,300 same-genus matches — e.g. three different Melamphaes species
  // all colloquially called "Ridgehead"). A tiny edit distance on the epithet itself is a
  // much stronger duplicate signal than genus alone.
  function levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  const MAX_EPITHET_EDIT_DISTANCE = 2;
  const highConfidenceLines: string[] = [];
  const sameGenusLines: string[] = [];
  let otherCount = 0;
  const seenPairs = new Set<string>();
  for (const row of res.rows) {
    for (const alias of row.common_name_aliases ?? []) {
      const matches = byPrimaryNameLower.get(alias.toLowerCase());
      if (!matches) continue;
      for (const match of matches) {
        if (match.id === row.id) continue;
        const pairKey = [row.id, match.id].sort().join(":");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const line = `${row.scientific_name} (alias "${alias}") == ${match.scientific_name} (primary "${match.common_name}")`;
        if (genusOf(row.scientific_name) !== genusOf(match.scientific_name)) {
          otherCount++;
          continue;
        }
        const editDistance = levenshtein(epithetOf(row.scientific_name), epithetOf(match.scientific_name));
        if (editDistance > 0 && editDistance <= MAX_EPITHET_EDIT_DISTANCE) {
          highConfidenceLines.push(line);
        } else {
          sameGenusLines.push(line);
        }
      }
    }
  }
  console.log(`[HIGH CONFIDENCE — same genus, near-identical epithet spelling, worth merging after a quick check]`);
  for (const line of highConfidenceLines) console.log("  " + line);
  console.log(`\n[same genus, different epithet — likely just a shared congener vernacular name, lower priority]`);
  for (const line of sameGenusLines) console.log("  " + line);
  console.log(
    `\ndone. ${highConfidenceLines.length} high-confidence candidate(s), ${sameGenusLines.length} lower-priority same-genus candidate(s), ${otherCount} coincidental cross-genus name matches (almost certainly noise) across ${res.rows.length} species.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
