import type { Pool } from "pg";
import type { KeywordMatchedSpecies } from "./matchByKeywords.js";

// Tools separate filename parts with underscores, hyphens, dots or parentheses, so all of that
// becomes plain spaces, e.g. "AMRO_CentralPark_2024-05-01.jpg" -> "AMRO CentralPark 2024 05 01 jpg".
// Padded with spaces so a plain substring check enforces word boundaries without a regex.
function normalizeAndPad(text: string): string {
  const normalized = text
    .replace(/[_\-.()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized ? ` ${normalized} ` : "";
}

interface NameMatchRow {
  id: string;
  scientific_name: string;
  common_name: string | null;
  taxon_class: string | null;
  family: string | null;
  matched_len: number;
}

// Best-effort species identification from a file's name and folder name, for files with no
// keyword tags. Deliberately conservative, since a wrong match silently misfiles a photo:
//   1. A standalone token that is an exact ABA or eBird code.
//   2. A common name, alias or scientific name as a whole word or phrase. Only the longest
//      matching name wins, so "Robin" never beats "American Robin".
export async function matchSpeciesFromFilename(pool: Pool, rawText: string): Promise<KeywordMatchedSpecies[]> {
  const padded = normalizeAndPad(rawText);
  if (!padded.trim()) return [];
  const tokens = padded.trim().split(" ");

  const codeMatches = await pool.query<KeywordMatchedSpecies>(
    `SELECT DISTINCT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family
     FROM species s
     WHERE lower(s.aba_code) = ANY($1) OR lower(s.ebird_code) = ANY($1)`,
    [tokens],
  );
  if (codeMatches.rows.length > 0) return codeMatches.rows;

  const [commonRes, sciRes, aliasRes] = await Promise.all([
    pool.query<NameMatchRow>(
      `SELECT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family, length(s.common_name) AS matched_len
       FROM species s
       WHERE s.common_name IS NOT NULL AND position((' ' || lower(s.common_name) || ' ') IN $1) > 0`,
      [padded],
    ),
    pool.query<NameMatchRow>(
      `SELECT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family, length(s.scientific_name) AS matched_len
       FROM species s
       WHERE position((' ' || lower(s.scientific_name) || ' ') IN $1) > 0`,
      [padded],
    ),
    pool.query<NameMatchRow>(
      `SELECT s.id, s.scientific_name, s.common_name, s.taxon_class, s.family, length(a) AS matched_len
       FROM species s, unnest(s.common_name_aliases) a
       WHERE position((' ' || lower(a) || ' ') IN $1) > 0`,
      [padded],
    ),
  ]);
  const allMatches = [...commonRes.rows, ...sciRes.rows, ...aliasRes.rows];
  if (allMatches.length === 0) return [];

  // One row per species with its longest matching name, then only the species whose match is
  // longest overall, so a shorter name inside a longer real match never wins.
  const bestPerSpecies = new Map<string, NameMatchRow>();
  for (const row of allMatches) {
    const existing = bestPerSpecies.get(row.id);
    if (!existing || row.matched_len > existing.matched_len) bestPerSpecies.set(row.id, row);
  }
  const candidates = [...bestPerSpecies.values()];
  const maxLen = Math.max(...candidates.map((r) => r.matched_len));
  return candidates
    .filter((r) => r.matched_len === maxLen)
    .map(({ id, scientific_name, common_name, taxon_class, family }) => ({
      id,
      scientific_name,
      common_name,
      taxon_class,
      family,
    }));
}
