// Source: Wikipedia's action API extracts (en.wikipedia.org/w/api.php?action=query&prop=extracts).
// License: article text is CC BY-SA - attribution + a link back is required.
//
// Pulls the article's "Description" section specifically (plumage/size - the actual
// quick-ID content, closer in spirit to Merlin's ID text) rather than the generic lead
// sentence, which tends to be taxonomic/range boilerplate ("X is a small bird that breeds
// in..."). Falls back to the lead paragraph when no Description section exists. Still NOT
// sourced from Merlin itself, whose text is proprietary and explicitly excluded
// (lifer-spec.md section 5) - Wikipedia is the approved, differently-licensed substitute.
// Kept to a couple of sentences, not the full section, per the product's own non-goal of
// not being a field guide (lifer-spec.md section 2) - a quick-glance caption, not
// encyclopedic content reproduced wholesale.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchWithRetry } from "../fetch-with-retry.js";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const MAX_SENTENCES = 2;
const DESCRIPTION_HEADINGS = ["description", "identification", "appearance"];

// A marker that will never appear in real article text, used to hide a decimal point's
// period from the sentence splitter, then converted back to a literal period afterward.
const DECIMAL_MARKER = "@@DECIMALPOINT@@";

export interface WikipediaSummaryRow {
  description: string | null;
  descriptionCredit: string | null;
  descriptionSourceUrl: string | null;
}

interface QueryResponse {
  query?: { pages: Record<string, { title?: string; extract?: string; missing?: string }> };
}

function truncateToSentences(text: string, maxSentences: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  // These Description sections are full of measurements ("0.72-1.58 kg"), which a naive
  // split-on-period would mistake for sentence boundaries. Swap decimal points for a marker
  // before splitting on real sentence boundaries, then swap the marker back afterward.
  const marked = normalized.replace(/(\d)\.(\d)/g, "$1" + DECIMAL_MARKER + "$2");
  const sentences = marked.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const joined = sentences.slice(0, maxSentences).join(" ");
  return joined.split(DECIMAL_MARKER).join(".").trim();
}

/** Splits the explaintext extract into { heading (lowercased) -> body } sections, plus the lead under "". */
function splitSections(extract: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headingPattern = /^==+\s*(.+?)\s*==+$/gm;

  let lastIndex = 0;
  let lastHeading = "";
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(extract))) {
    sections.set(lastHeading, extract.slice(lastIndex, match.index).trim());
    lastHeading = match[1].trim().toLowerCase();
    lastIndex = headingPattern.lastIndex;
  }
  sections.set(lastHeading, extract.slice(lastIndex).trim());
  return sections;
}

export async function fetchWikipediaSummary(title: string): Promise<WikipediaSummaryRow> {
  const url =
    WIKIPEDIA_API +
    "?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=" +
    encodeURIComponent(title);
  const res = await fetchWithRetry(url, { headers: { "User-Agent": "lifer-data-pipeline/0.1 (personal project)" } });
  if (!res.ok) return { description: null, descriptionCredit: null, descriptionSourceUrl: null };

  const data = (await res.json()) as QueryResponse;
  const page = data.query ? Object.values(data.query.pages)[0] : undefined;
  if (!page?.extract || page.missing !== undefined) {
    return { description: null, descriptionCredit: null, descriptionSourceUrl: null };
  }

  const sections = splitSections(page.extract);
  const descriptionHeading = DESCRIPTION_HEADINGS.find((h) => sections.has(h) && sections.get(h));
  const body = descriptionHeading ? sections.get(descriptionHeading)! : sections.get("") ?? page.extract;

  const canonicalTitle = page.title ?? title;
  const pageUrl = "https://en.wikipedia.org/wiki/" + encodeURIComponent(canonicalTitle.replace(/ /g, "_"));
  return {
    description: truncateToSentences(body, MAX_SENTENCES),
    descriptionCredit: "Wikipedia contributors (CC BY-SA)",
    descriptionSourceUrl: pageUrl,
  };
}

async function main() {
  const wikidataPath = path.join(BUILD_DIR, "wikidata.json");
  const rows = JSON.parse((await import("node:fs")).readFileSync(wikidataPath, "utf-8")) as Array<{
    scientificName: string;
    wikipediaTitle: string | null;
  }>;

  const results: Array<{ scientificName: string } & WikipediaSummaryRow> = [];
  for (const r of rows) {
    if (!r.wikipediaTitle) {
      results.push({ scientificName: r.scientificName, description: null, descriptionCredit: null, descriptionSourceUrl: null });
      continue;
    }
    const summary = await fetchWikipediaSummary(r.wikipediaTitle);
    results.push({ scientificName: r.scientificName, ...summary });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "wikipedia-summaries.json");
  writeFileSync(dest, JSON.stringify(results, null, 2));
  console.log(
    "[wikipedia-summary] wrote " + results.length + " rows (" +
      results.filter((r) => r.description).length + " with a blurb) to " + dest,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
