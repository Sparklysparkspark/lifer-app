// Source: Wikipedia's action API extracts (en.wikipedia.org/w/api.php?action=query&prop=extracts).
// License: article text is CC BY-SA - attribution + a link back is required.
//
// One article's description by the shared rule (packages/core/src/species/descriptionText.ts):
// the lead and the article's Description/Identification/Appearance section, taxonomy, etymology,
// synonyms, place-name range lines and conservation boilerplate dropped, whole sentences up to
// 800 characters. The same rule as backfill-descriptions.ts (which does this in bulk) and the
// on-view iNaturalist path. Not sourced from Merlin, whose text is proprietary.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "@lifer/core/rawCache.js";
import { composeDescription } from "@lifer/core/species/descriptionText.js";
import { articleUrl, fetchIntros, PoliteClient } from "./wikipediaArticles.js";
import { fetchIdentificationSections, WIKIPEDIA_DESCRIPTION_CREDIT } from "../scripts/backfill-descriptions.js";

export interface WikipediaSummaryRow {
  description: string | null;
  descriptionCredit: string | null;
  descriptionSourceUrl: string | null;
}

const client = new PoliteClient({ minIntervalMs: 200 });

export async function fetchWikipediaSummary(title: string, lang = "en"): Promise<WikipediaSummaryRow> {
  const none = { description: null, descriptionCredit: null, descriptionSourceUrl: null };
  const intro = (await fetchIntros(client, lang, [title])).get(title);
  if (!intro) return none;
  const sections = await fetchIdentificationSections(client, lang, [intro]);
  const description = composeDescription({
    lead: intro.extract,
    identificationSection: sections.get(intro.title) ?? null,
  });
  if (!description) return none;
  return {
    description,
    descriptionCredit: WIKIPEDIA_DESCRIPTION_CREDIT,
    descriptionSourceUrl: articleUrl(lang, intro.title),
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
      results.push({
        scientificName: r.scientificName,
        description: null,
        descriptionCredit: null,
        descriptionSourceUrl: null,
      });
      continue;
    }
    const summary = await fetchWikipediaSummary(r.wikipediaTitle);
    results.push({ scientificName: r.scientificName, ...summary });
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "wikipedia-summaries.json");
  writeFileSync(dest, JSON.stringify(results, null, 2));
  console.log(
    "[wikipedia-summary] wrote " +
      results.length +
      " rows (" +
      results.filter((r) => r.description).length +
      " with a blurb) to " +
      dest,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
