// Finds species pairs that are likely the SAME real-world species duplicated under two
// scientific names — almost always a taxonomic genus reclassification imported at two
// different times/sources (e.g. "Ianthocincla lunulata" and "Garrulax lunulatus" — same
// species epithet "lunulata/lunulatus", different genus, same English name "Barred
// Laughingthrush"). Matching on (common_name + species epithet) rather than common_name alone
// avoids false positives like fish where many genuinely distinct species legitimately share a
// generic group name ("Cichlid", "Tetra") with no unique English name at all — those have
// different epithets too, so they won't match here.
//
// For each candidate pair, resolves which side iNaturalist currently recognizes as the
// species-rank taxon (the "current" name) vs. which side has no species-rank match at all
// (the "stale" name, only findable — if at all — as a subspecies, exactly like Green-Winged
// Teal). Read-only: reports findings, does not modify anything.
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 8;
const INAT_API = "https://api.inaturalist.org/v1";

// Deliberately species-rank-only (unlike lazyEnrich.ts's fetchINaturalistTaxon, which also
// falls back to a subspecies match) — for telling "current" from "stale" apart, both sides
// matching via the subspecies fallback would be useless; only an exact species-rank hit
// counts as "this is the name iNaturalist currently recognizes as its own species."
async function fetchINaturalistSpeciesRankExact(scientificName: string): Promise<boolean> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(scientificName)}&rank=species&is_active=true&per_page=10`;
  const res = await fetch(url);
  if (!res.ok) return false;
  const data = (await res.json()) as { results: Array<{ name: string }> };
  return data.results.some((r) => r.name.toLowerCase() === scientificName.toLowerCase());
}

function epithet(scientificName: string): string {
  const parts = scientificName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function genus(scientificName: string): string {
  return scientificName.trim().split(/\s+/)[0].toLowerCase();
}

async function main() {
  const res = await pool.query<{
    id: string;
    common_name: string;
    scientific_name: string;
    taxon_class: string;
    enriched_at: Date | null;
  }>(
    `SELECT id, common_name, scientific_name, taxon_class, enriched_at
     FROM species
     WHERE common_name IS NOT NULL AND taxon_class IN ('aves', 'mammalia')`,
  );

  const byNameAndEpithet = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    const key = `${row.common_name.toLowerCase()}|${epithet(row.scientific_name)}`;
    const group = byNameAndEpithet.get(key) ?? [];
    group.push(row);
    byNameAndEpithet.set(key, group);
  }

  const candidateGroups = [...byNameAndEpithet.values()].filter(
    (g) => g.length > 1 && new Set(g.map((r) => genus(r.scientific_name))).size > 1,
  );

  console.log(`${candidateGroups.length} candidate duplicate groups (same common name + species epithet, different genus)\n`);

  interface Resolved {
    group: typeof res.rows;
    current: (typeof res.rows)[number] | null;
    stale: Array<(typeof res.rows)[number]>;
  }

  let processed = 0;
  const resolved: Resolved[] = await mapWithConcurrency(candidateGroups, CONCURRENCY, async (group) => {
    const withInat = await Promise.all(
      group.map(async (row) => ({ row, isCurrent: await fetchINaturalistSpeciesRankExact(row.scientific_name) })),
    );
    const speciesRankHits = withInat.filter((w) => w.isCurrent);
    const current = speciesRankHits.length === 1 ? speciesRankHits[0].row : null;
    const stale = group.filter((r) => r.id !== current?.id);
    processed++;
    if (processed % 20 === 0) console.log(`  ${processed}/${candidateGroups.length} groups checked...`);
    return { group, current, stale };
  });

  const clean = resolved.filter((r) => r.current);
  const ambiguous = resolved.filter((r) => !r.current);

  console.log(`${clean.length} groups resolved cleanly (exactly one side matches iNaturalist)`);
  console.log(`${ambiguous.length} groups ambiguous (0 or 2+ iNaturalist matches — needs manual review)\n`);

  for (const r of clean) {
    console.log(
      `KEEP: ${r.current!.scientific_name} (${r.current!.common_name}) [${r.current!.id}]  <-  MERGE: ${r.stale.map((s) => `${s.scientific_name} [${s.id}]`).join(", ")}`,
    );
  }

  if (ambiguous.length > 0) {
    console.log("\n--- AMBIGUOUS (not auto-resolved) ---");
    for (const r of ambiguous) {
      console.log(`  ${r.group.map((g) => `${g.scientific_name} [${g.id}]`).join(" vs ")} (common: ${r.group[0].common_name})`);
    }
  }

  // Dump machine-readable output for the follow-up merge script.
  const fs = await import("node:fs");
  fs.writeFileSync(
    "/tmp/duplicate-species-resolved.json",
    JSON.stringify(
      clean.map((r) => ({ keepId: r.current!.id, mergeIds: r.stale.map((s) => s.id) })),
      null,
      2,
    ),
  );
  console.log(`\nWrote ${clean.length} resolved merge pairs to /tmp/duplicate-species-resolved.json`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
