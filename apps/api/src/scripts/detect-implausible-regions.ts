// Rather than checking every species in every region against Wikipedia (expensive, and not
// reliable enough to fully automate for well-documented species anyway), this only checks two
// small, already-cheap-to-query candidate sets:
//   1. Species with NO reference photo found anywhere — a proxy for "obscure enough that a
//      region entry might be a data error." Catches species that are globally obscure.
//   2. region_species rows with local_tier epic/legendary AND local_frequency <= 2 — catches a
//      different pattern: a species that's perfectly well-documented and common in its real
//      range, but shows up as a near-single-record outlier somewhere implausible (e.g. a
//      species placed outside its real range by a single decades-old museum specimen record).
//      The low-count threshold matters here, not tier-mismatch-across-regions alone: genuine
//      rare vagrants (Steller's Eider, McKay's Bunting) still have several records, while real
//      misidentification artifacts sit right at 1-2.
//
// Only ever flags "endemic to/restricted to X" for manual review, never auto-excludes —
// matching a free-text place name back to real geography is not reliable enough to trust blind
// deletion. "Extinct in the wild" tagging used to also live here (Wikipedia-text pattern
// matching via iNaturalist), but moved to check-extinction-status.ts, which gets the SAME
// signal from GBIF's own structured IUCN threatStatus field ("EXTINCT_IN_THE_WILD" — confirmed
// live for Spix's Macaw) instead of regex against free text — more reliable, and GBIF's
// distributions endpoint has never shown the sustained rate-limit throttling this script's own
// iNaturalist calls did on a 20k+ candidate run.
import { pool } from "../db.js";
// iNaturalist's own taxon record already carries the full Wikipedia article text in
// wikipedia_summary (see lazyEnrich.ts's fetchINaturalistTaxon/stripHtml) and is never
// rate-limited the way hitting en.wikipedia.org's API directly for ~1200 species in a row is
// (that used to draw a 429 roughly every other request, each with a 50s+ backoff). Reuses
// fetchWithRetry for the same host-pacing/retry behavior other iNaturalist calls get.
import { fetchWithRetry, stripHtml } from "../species/lazyEnrich.js";

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
  // --regions=Canada,Finland scopes this pass to species that appear on those regions'
  // checklists first — prioritizes whichever regions have an actual test pack right now, ahead
  // of the much larger full-catalog sweep. Not a perfect scope (a flagged species might ALSO
  // sit on other regions' checklists, still reported/tagged for all of them, same as an
  // unscoped run), but it means the first, most-relevant candidates get checked first.
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
       array_agg(DISTINCT r.name) FILTER (WHERE rs.local_tier IN ('epic', 'legendary') AND rs.local_frequency <= 2) AS flagged_regions
     FROM species s
     JOIN region_species rs ON rs.species_id = s.id
     JOIN regions r ON r.id = rs.region_id
     ${regionNames ? `WHERE s.id IN (
       SELECT rs2.species_id FROM region_species rs2 JOIN regions r2 ON r2.id = rs2.region_id WHERE r2.name = ANY($1)
     )` : ""}
     GROUP BY s.id, s.scientific_name, s.common_name
     HAVING bool_or(s.reference_photo IS NULL AND s.enriched_at IS NOT NULL)
        OR bool_or(rs.local_tier IN ('epic', 'legendary') AND rs.local_frequency <= 2)
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
      // fetchWithRetry already retries on 429/5xx, but a connection-level failure (a transient
      // network drop, seen for real: ENETUNREACH mid-run) isn't an HTTP response at all, so it
      // throws straight through. Without this try/catch, one bad request crashed the ENTIRE
      // run — discarding up to ~40 minutes of already-completed work, since this script has no
      // per-species "already checked" marker to resume from (unlike check-extinction-status.ts's
      // extinction_checked_at) — for the sake of one skippable candidate. Logged and skipped
      // instead; a real, persistent outage still shows up as a big final `failed` count.
      //
      // Genus is only fetched as a FALLBACK, not unconditionally — it exists for species with
      // no Wikipedia article of their own (covered only within a shared genus-level page, see
      // the genus-match guard below), not as a second opinion for species that already have
      // real text. Firing both requests via Promise.all every single time was doubling this
      // script's real request volume against an already-tight rate limit for no benefit on
      // every well-documented candidate. The (rare) cost: a species WITH its own article that
      // doesn't mention endemism, whose genus page happens to separately say something relevant
      // about it specifically, no longer gets checked — accepted given the throughput this
      // recovers.
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
