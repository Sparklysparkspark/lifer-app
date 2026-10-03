// Source: Callaghan et al. 2021, "Global abundance estimates for 9,700 bird species," PNAS
// 118(21):e2023170118, data via Zenodo (doi.org/10.5281/zenodo.4723365). License: CC-BY-4.0.
// Only the small "Tables.zip" is fetched, never the 8.7GB "eBird data.zip": raw eBird data has
// its own more restrictive terms, and all_species_summary_table.csv already has the population
// estimates needed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchCached, RAW_DIR } from "../raw-cache.js";

const execFileAsync = promisify(execFile);
const TABLES_ZIP_URL = "https://zenodo.org/records/4723365/files/Tables.zip?download=1";

export interface BirdAbundanceRow {
  scientificName: string;
  populationEstimate: number;
}

function parseCsv(text: string): Record<string, string>[] {
  // Quote-aware split (as in fetch-mdd.ts): the Family field, e.g. "Ardeidae (Herons, Egrets, and
  // Bitterns)", contains a comma.
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export async function fetchBirdAbundance(): Promise<BirdAbundanceRow[]> {
  const zipPath = await fetchCached("bird-abundance", "Tables.zip", TABLES_ZIP_URL);
  const csvPath = path.join(RAW_DIR, "bird-abundance", "Tables", "all_species_summary_table.csv");
  if (!existsSync(csvPath)) {
    await execFileAsync("unzip", ["-o", zipPath, "-d", path.join(RAW_DIR, "bird-abundance")]);
  }

  const rows = parseCsv(readFileSync(csvPath, "utf-8"));
  const results: BirdAbundanceRow[] = [];
  for (const row of rows) {
    const scientificName = row["Scientific name"];
    const populationEstimate = Number(row["Abundance estimate"]);
    if (!scientificName || !Number.isFinite(populationEstimate) || populationEstimate <= 0) continue;
    results.push({ scientificName, populationEstimate });
  }
  console.log(`[bird-abundance] parsed ${results.length} species population estimates`);
  return results;
}
