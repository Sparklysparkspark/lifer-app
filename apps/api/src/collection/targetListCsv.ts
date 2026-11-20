// Reading a target list CSV and choosing each name's species. Pure, so the rules are unit tested.
import { parseCsv } from "../integrations/ebird/csv.js";

// Larger than any real target list.
export const MAX_NAMES = 20_000;

// Headers compared lowercased with spaces, dashes and underscores dropped.
const SCIENTIFIC_HEADERS = new Set(["scientificname", "sciname", "scientific", "latinname", "latin", "binomial"]);
const COMMON_HEADERS = new Set(["commonname", "common", "englishname", "vernacularname", "name", "species"]);
const headerKey = (h: string) => h.toLowerCase().replace(/[\s_-]+/g, "");

/** Every distinct name in the file, in file order. Reads the Scientific Name column, else the
 *  Common Name one; a one-column file needs no header. Throws a plain message for any other file. */
export function readTargetNames(text: string): string[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("The file is empty.");
  const header = rows[0].map(headerKey);
  let col = header.findIndex((h) => SCIENTIFIC_HEADERS.has(h));
  if (col < 0) col = header.findIndex((h) => COMMON_HEADERS.has(h));
  let body = rows.slice(1);
  if (col < 0) {
    if (rows.some((r) => r.filter((f) => f.trim()).length > 1))
      throw new Error('The file needs a "Scientific Name" or "Common Name" column.');
    col = 0;
    body = rows;
  }
  const names = new Set<string>();
  for (const row of body) {
    const name = row[col]?.trim();
    if (name) names.add(name);
  }
  if (names.size > MAX_NAMES) throw new Error(`The file has more than ${MAX_NAMES.toLocaleString("en")} names.`);
  return [...names];
}

export type NameKind = "scientific" | "synonym" | "common" | "alias";
export interface NameHit {
  name: string;
  speciesId: string;
  kind: NameKind;
}
export interface NameMatch {
  name: string;
  status: "matched" | "ambiguous" | "unmatched";
  speciesIds: string[];
}

// Exact scientific name first, then a former scientific name, then a common name or alias.
const RANK: Record<NameKind, number> = { scientific: 0, synonym: 1, common: 2, alias: 2 };

/** Each name's species at its best kind of match: one is matched, several are for the user to pick. */
export function pickMatches(names: string[], hits: NameHit[]): NameMatch[] {
  const byName = new Map<string, NameHit[]>();
  for (const h of hits) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
  return names.map((name) => {
    const found = byName.get(name) ?? [];
    const best = Math.min(...found.map((h) => RANK[h.kind]));
    const speciesIds = [...new Set(found.filter((h) => RANK[h.kind] === best).map((h) => h.speciesId))];
    const status = speciesIds.length === 0 ? "unmatched" : speciesIds.length === 1 ? "matched" : "ambiguous";
    return { name, status, speciesIds };
  });
}
