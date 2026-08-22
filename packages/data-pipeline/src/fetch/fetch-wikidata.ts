// Source: Wikidata SPARQL endpoint (query.wikidata.org/sparql). License: CC0.
// Pulls IUCN conservation status (P141) and canonical Commons image (P18) per species,
// matched by scientific name (P225, "taxon name"). Queried in batches via VALUES since
// pulling all ~11k species in one query risks a timeout.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const BATCH_SIZE = 100;

export interface WikidataRow {
  scientificName: string;
  iucnStatus: string | null;
  commonsImage: string | null;
  wikipediaTitle: string | null;
}

interface SparqlBinding {
  name: { value: string };
  iucnLabel?: { value: string };
  image?: { value: string };
  wikipediaTitle?: { value: string };
}

// A real, disclosed data gap: GBIF's backbone and Wikidata sometimes disagree on which
// scientific name is "current" for a
// reclassified species, and Wikidata itself often SPLITS the two names into separate items
// linked by P1420 "taxon synonym" — one item (matching GBIF's own name, and sometimes even
// carrying GBIF's OWN taxon ID under P846) with no IUCN statement at all, and a second item
// under the other name carrying the real P141 IUCN status. Snow Leopard is the exact case:
// our GBIF-backbone name "Uncia uncia" matches a Wikidata item with zero P141, while
// "Panthera uncia" — linked to it via P1420 in BOTH directions across the two live items —
// carries "vulnerable." Falling back through P1420 in either direction (a synonym item may
// point either way) recovers this without needing to change which scientific name we store
// or query by.
function buildQuery(names: string[]): string {
  return `
    SELECT ?name ?iucnLabel ?image ?wikipediaTitle WHERE {
      VALUES ?nameStr { ${names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(" ")} }
      ?taxon wdt:P225 ?nameStr .
      BIND(?nameStr AS ?name)
      OPTIONAL {
        { ?taxon wdt:P141 ?iucn }
        UNION
        { ?taxon wdt:P1420 ?synonymTaxon . ?synonymTaxon wdt:P141 ?iucn }
        UNION
        { ?otherSynonymTaxon wdt:P1420 ?taxon . ?otherSynonymTaxon wdt:P141 ?iucn }
        ?iucn rdfs:label ?iucnLabel . FILTER(LANG(?iucnLabel) = "en")
      }
      OPTIONAL { ?taxon wdt:P18 ?image . }
      OPTIONAL {
        ?article schema:about ?taxon .
        ?article schema:isPartOf <https://en.wikipedia.org/> .
        ?article schema:name ?wikipediaTitle .
      }
    }
  `;
}

async function runQuery(names: string[]): Promise<WikidataRow[]> {
  const query = buildQuery(names);
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": "lifer-data-pipeline/0.1 (personal project)" } });
  if (!res.ok) {
    throw new Error(`[wikidata] fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { results: { bindings: SparqlBinding[] } };

  const rows: WikidataRow[] = [];
  for (const b of data.results.bindings) {
    rows.push({
      scientificName: b.name.value,
      iucnStatus: b.iucnLabel?.value ?? null,
      commonsImage: b.image?.value ?? null,
      wikipediaTitle: b.wikipediaTitle?.value ?? null,
    });
  }
  return rows;
}

export async function fetchWikidataForSpecies(scientificNames: string[]): Promise<WikidataRow[]> {
  const results: WikidataRow[] = [];
  for (let i = 0; i < scientificNames.length; i += BATCH_SIZE) {
    const batch = scientificNames.slice(i, i + BATCH_SIZE);
    console.log(`[wikidata] batch ${i / BATCH_SIZE + 1} / ${Math.ceil(scientificNames.length / BATCH_SIZE)}`);
    const rows = await runQuery(batch);
    results.push(...rows);
    // Be polite to a shared public endpoint.
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

async function main() {
  const gbifPath = path.join(BUILD_DIR, "gbif-backbone-aves.json");
  const gbifRows = JSON.parse((await import("node:fs")).readFileSync(gbifPath, "utf-8")) as Array<{
    scientificName: string;
    canonicalName: string | null;
  }>;
  // canonicalName is the plain binomial; scientificName carries the authorship string
  // ("... Linnaeus, 1758") which wouldn't match Wikidata's taxon-name property.
  const names = gbifRows.map((r) => r.canonicalName ?? r.scientificName);

  const rows = await fetchWikidataForSpecies(names);
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "wikidata.json");
  writeFileSync(dest, JSON.stringify(rows, null, 2));
  console.log(`[wikidata] wrote ${rows.length} rows to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
