import type { Pool } from "pg";
import type { KeywordMatchedSpecies } from "./matchByKeywords.js";

// External tools separate identifying info (species name/code, sometimes a location, a date,
// a sequence number) with underscores, hyphens, dots, or parentheses, inconsistently across
// libraries — normalizing all of that to plain spaces turns whatever convention someone used
// into one flat, searchable string, e.g. "AMRO_CentralPark_2024-05-01.jpg" -> "AMRO CentralPark
// 2024 05 01 jpg" and "American-Robin (Turdus migratorius).jpg" -> "American Robin Turdus
// migratorius jpg". Padded with a leading/trailing space so a plain substring check below
// (rather than a hand-built regex, which would need per-row escaping for names containing
// regex metacharacters) still enforces real word boundaries: " robin " is not found inside
// "americanrobin ", only inside "... american robin ...".
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

// Best-effort species identification straight from a file's name and/or enclosing folder name
// — a fallback for files with NO usable embedded (or sidecar) keyword tags at all, common for
// libraries organized purely by naming/foldering convention rather than IPTC/XMP metadata.
// Two independent, deliberately conservative signals — a wrong auto-match silently misfiling a
// photo is worse than leaving it in the "unrecognized"/"ambiguous" pile for a human to place:
//   1. A standalone token that's an exact ABA or eBird code (cheap, unambiguous — codes are
//      short, fixed-format, and not realistically going to appear by coincidence).
//   2. A known common name, alias, or scientific name appearing as a whole word/phrase — and a
//      name that's itself a substring of a different, longer, more specific match (e.g.
//      "Robin" vs "American Robin") never wins over it: only the single longest matching name
//      (or a genuine tie) is returned.
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

  // One row per species, keeping only its own longest matching name, THEN only the species
  // whose matched name is longest overall — a short name that's also a substring of a longer,
  // more specific real match never wins over it.
  const bestPerSpecies = new Map<string, NameMatchRow>();
  for (const row of allMatches) {
    const existing = bestPerSpecies.get(row.id);
    if (!existing || row.matched_len > existing.matched_len) bestPerSpecies.set(row.id, row);
  }
  const candidates = [...bestPerSpecies.values()];
  const maxLen = Math.max(...candidates.map((r) => r.matched_len));
  return candidates
    .filter((r) => r.matched_len === maxLen)
    .map(({ id, scientific_name, common_name, taxon_class, family }) => ({ id, scientific_name, common_name, taxon_class, family }));
}
