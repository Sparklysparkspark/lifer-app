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
// Two outcomes, deliberately asymmetric in how much they're trusted:
// - "extinct in the wild" is safe to apply as a pure informational tag wherever the species
//   appears — it never removes anything, since a real reintroduction population (Spix's
//   Macaw) can make a species both extinct-in-the-wild AND a legitimately findable target.
// - "endemic to/restricted to X" is only ever flagged for manual review, never auto-excluded —
//   matching a free-text place name back to real geography is not reliable enough to trust
//   blind deletion.
import { pool } from "../db.js";
// iNaturalist's own taxon record already carries the full Wikipedia article text in
// wikipedia_summary (see lazyEnrich.ts's fetchINaturalistTaxon/stripHtml) and is never
// rate-limited the way hitting en.wikipedia.org's API directly for ~1200 species in a row is
// (that used to draw a 429 roughly every other request, each with a 50s+ backoff). Reuses
// fetchWithRetry for the same host-pacing/retry behavior other iNaturalist calls get.
import { fetchWithRetry, stripHtml } from "../species/lazyEnrich.js";

const INAT_API = "https://api.inaturalist.org/v1";
const EXTINCT_IN_WILD_PATTERN = /\bextinct in the wild\b/i;
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
     GROUP BY s.id, s.scientific_name, s.common_name
     HAVING bool_or(s.reference_photo IS NULL AND s.enriched_at IS NOT NULL)
        OR bool_or(rs.local_tier IN ('epic', 'legendary') AND rs.local_frequency <= 2)
     ORDER BY s.scientific_name`,
  );
  console.log(`[detect-implausible] ${res.rows.length} candidate species to check (no-photo or near-single-record-outlier)`);

  const reviewFlags: string[] = [];
  let extinctFound = 0;
  let done = 0;

  for (const species of res.rows) {
    const genus = species.scientific_name.split(" ")[0];
    const speciesEpithet = species.scientific_name.split(" ")[1] ?? null;
    const [speciesText, genusText] = await Promise.all([
      fetchFullExtract(species.scientific_name, "species"),
      fetchFullExtract(genus, "genus"),
    ]);
    const combined = [speciesText, genusText].filter(Boolean).join("\n\n");
    done++;
    if (!combined) continue;

    // The species' own article is always safe to trust, but the genus-level article can
    // legitimately discuss a sibling species' extinction in the same shared genus page (e.g.
    // Alaska Sheefish/Stenodus nelma sharing a genus article with the already-extinct
    // Beloribitsa/Stenodus leucichthys) — a bare pattern match against the whole genus text
    // can't tell which species the sentence is actually about, so every species sharing that
    // genus would get tagged. A genus-level match only counts if the species' own name
    // (epithet or common name) appears within the same ~400-char window as the match — the
    // species' own article needs no such guard, since it's already about the right species by
    // construction.
    const speciesOwnMatch = speciesText ? EXTINCT_IN_WILD_PATTERN.test(speciesText) : false;
    let genusMatchIsAboutThisSpecies = false;
    if (genusText) {
      const match = EXTINCT_IN_WILD_PATTERN.exec(genusText);
      if (match) {
        const windowStart = Math.max(0, match.index - 400);
        const windowEnd = Math.min(genusText.length, match.index + 400);
        const window = genusText.slice(windowStart, windowEnd);
        genusMatchIsAboutThisSpecies =
          (speciesEpithet != null && window.includes(speciesEpithet)) ||
          (species.common_name != null && window.includes(species.common_name));
      }
    }

    if (speciesOwnMatch || genusMatchIsAboutThisSpecies) {
      await pool.query(`UPDATE species_traits SET extinct_in_wild = true WHERE species_id = $1`, [species.id]);
      extinctFound++;
      console.log(`[extinct-in-wild] ${species.scientific_name} (${species.common_name ?? "no common name"})`);
    }

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

  console.log(`\n[detect-implausible] done. ${done} checked, ${extinctFound} tagged extinct-in-wild, ${reviewFlags.length} flagged for region review.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
