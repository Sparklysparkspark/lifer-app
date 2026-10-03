// Populates species.aba_code (migration 077) and species.ebird_code from eBird's published
// taxonomy, which covers both:
//   - SPECIES_CODE: eBird's 6-character code, assigned to every bird species worldwide.
//   - BANDING_CODES: the 4-letter alpha codes birders call "ABA codes" (an IBP/AOS standard),
//     empty outside North America, Mexico, Central America and the Caribbean.
// Source file: data/reference/ebird-taxonomy.csv, from
// https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv (no API key needed). Re-download and
// rerun after a taxonomy update.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const CSV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../data/reference/ebird-taxonomy.csv");

// Minimal quoted-field CSV split: several eBird fields (COM_NAME_CODES etc.) contain quoted commas.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function main() {
  const lines = readFileSync(CSV_PATH, "utf8").split("\n").filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  const sciNameIdx = header.indexOf("SCIENTIFIC_NAME");
  const speciesCodeIdx = header.indexOf("SPECIES_CODE");
  const bandingCodeIdx = header.indexOf("BANDING_CODES");
  const categoryIdx = header.indexOf("CATEGORY");
  if (sciNameIdx === -1 || speciesCodeIdx === -1 || bandingCodeIdx === -1 || categoryIdx === -1) {
    throw new Error(`Unexpected CSV header, expected SCIENTIFIC_NAME/SPECIES_CODE/BANDING_CODES/CATEGORY columns: ${header.join(",")}`);
  }

  // "species" rows only: subspecies, hybrid, slash and spuh rows would collide with real species.
  const codesByScientificName = new Map<string, { speciesCode: string; abaCode: string | null }>();
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    if (cols[categoryIdx]?.trim() !== "species") continue;
    const sciName = cols[sciNameIdx]?.trim();
    const speciesCode = cols[speciesCodeIdx]?.trim();
    if (!sciName || !speciesCode) continue;
    codesByScientificName.set(sciName.toLowerCase(), { speciesCode, abaCode: cols[bandingCodeIdx]?.trim() || null });
  }
  console.log(`[backfill-aba-codes] ${codesByScientificName.size} species codes loaded from eBird taxonomy`);

  const res = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE taxon_class = 'aves'`,
  );
  let ebirdMatched = 0;
  let abaMatched = 0;
  for (const row of res.rows) {
    const match = codesByScientificName.get(row.scientific_name.toLowerCase());
    if (!match) continue;
    await pool.query(`UPDATE species SET ebird_code = $1, aba_code = $2 WHERE id = $3`, [match.speciesCode, match.abaCode, row.id]);
    ebirdMatched++;
    if (match.abaCode) abaMatched++;
  }
  console.log(`[backfill-aba-codes] ${ebirdMatched}/${res.rows.length} bird species matched an eBird code, ${abaMatched} also got an ABA code`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
