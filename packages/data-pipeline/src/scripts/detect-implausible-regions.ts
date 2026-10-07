// Flags possibly implausible region entries for manual review by checking the Wikipedia text
// ("endemic to X") of two small candidate sets:
//   1. Species with no reference photo anywhere (globally obscure, so a region entry might be a
//      data error).
//   2. Rows with a rare/legendary local_tier and local_frequency <= 2: a near-single-record
//      outlier outside the real range. Real vagrants usually have several records.
//
// Never auto-excludes: matching free-text place names to geography isn't reliable enough.
import { pool } from "@lifer/core/db.js";
// Wikipedia text comes from iNaturalist's wikipedia_summary, which doesn't rate-limit like
// Wikipedia's own API.
import { fetchWithRetry, stripHtml } from "@lifer/core/species/lazyEnrich.js";

const INAT_API = "https://api.inaturalist.org/v1";
const ENDEMIC_PATTERN = /\b(?:endemic to|restricted to|confined to|only found in)\s+((?:(?!\.|,\s+(?:and|but|though)|;)[^.;])+)/i;

async function fetchFullExtract(name: string, rank: "species" | "genus"): Promise<string | null> {
  const url = `${INAT_API}/taxa?q=${encodeURIComponent(name)}&rank=${rank}&is_active=true&per_page=10`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results: Array<{ name: string; wikipedia_summary?: string | null }>;
  };
  const match = data.results.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? data.results[0];
  if (!match?.wikipedia_summary) return null;
  return stripHtml(match.wikipedia_summary);
}

async function main() {
  // --regions=Canada,Finland limits the pass to species on those regions' checklists.
  const regionsArg = process.argv.find((a) => a.startsWith("--regions="));
  const regionNames = regionsArg ? regionsArg.split("=")[1].split(",") : null;
  const res = await pool.query<{
    id: string;
    scientific_name: string;
    common_name: string | null;
    regions: string[];
    flagged_regions: string[];
  }>(
    `SELECT s.id, s.scientific_name, s.common_name,
       array_agg(DISTINCT r.name) AS regions,
       array_agg(DISTINCT r.name) FILTER (WHERE rs.local_tier IN ('rare', 'legendary') AND rs.local_frequency <= 2) AS flagged_regions
     FROM species s
     JOIN region_species rs ON rs.species_id = s.id
     JOIN regions r ON r.id = rs.region_id
     ${regionNames ? `WHERE s.id IN (
       SELECT rs2.species_id FROM region_species rs2 JOIN regions r2 ON r2.id = rs2.region_id WHERE r2.name = ANY($1)
     )` : ""}
     GROUP BY s.id, s.scientific_name, s.common_name
     HAVING bool_or(s.reference_photo IS NULL AND s.enriched_at IS NOT NULL)
        OR bool_or(rs.local_tier IN ('rare', 'legendary') AND rs.local_frequency <= 2)
     ORDER BY s.scientific_name`,
    regionNames ? [regionNames] : [],
  );
  console.log(`[detect-implausible] ${res.rows.length} candidate species to check (no-photo or near-single-record-outlier)`);

  const reviewFlags: string[] = [];
  let done = 0;

  let failed = 0;
  for (const species of res.rows) {
    const genus = species.scientific_name.split(" ")[0];
    let speciesText: string | null;
    let genusText: string | null;
    try {
      // Network errors throw past fetchWithRetry; skip the species rather than lose the run.
      // The genus page is only a fallback for species with no article of their own.
      speciesText = await fetchFullExtract(species.scientific_name, "species");
      genusText = speciesText ? null : await fetchFullExtract(genus, "genus");
    } catch (err) {
      console.error(`[detect-implausible] SKIP ${species.scientific_name}: ${(err as Error).message}`);
      failed++;
      done++;
      continue;
    }
    const combined = [speciesText, genusText].filter(Boolean).join("\n\n");
    done++;
    if (!combined) continue;

    const endemicMatch = combined.match(ENDEMIC_PATTERN);
    const flaggedRegions = species.flagged_regions ?? [];
    if (endemicMatch || flaggedRegions.length > 0) {
      const location = endemicMatch ? endemicMatch[1].trim() : null;
      const parts = [
        location ? `Wikipedia says "${location}"` : null,
        flaggedRegions.length > 0 ? `near-single-record outlier in: ${flaggedRegions.join(", ")}` : null,
      ].filter(Boolean);
      const line = `${species.scientific_name} (${species.common_name ?? "no common name"}) -- ${parts.join("; ")} -- all regions listed in: ${species.regions.join(", ")}`;
      reviewFlags.push(line);
      console.log(`[REVIEW] ${line}`);
    }

    if (done % 50 === 0) console.log(`[detect-implausible] ${done}/${res.rows.length}`);
  }

  console.log(
    `\n[detect-implausible] done. ${done} checked (${failed} skipped on error), ${reviewFlags.length} flagged for region review.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
