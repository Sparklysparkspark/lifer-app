// Source: EltonTraits 1.0 (Wilman, H. et al. 2014, Ecology 95:2027), figshare collection
// 10.6084/m9.figshare.c.3306933.v1. License: CC BY 4.0 — cite per lifer-spec.md §11.
// Only used to fill diet/foraging-stratum/nocturnality gaps AVONET doesn't cover (spec §5).
// Real column layout (verified against the actual BirdFuncDat.txt, tab-separated):
// "Scientific" is the binomial; "Diet-5Cat" is a ready-made category; foraging stratum is
// NOT a single column — it's 7 percentage columns (ForStrat-watbelowsurf/wataroundsurf/
// ground/understory/midhigh/canopy/aerial) that sum to 100, so we take the argmax as the
// dominant stratum; "Nocturnal" is a 0/1 flag.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchCached, BUILD_DIR } from "../raw-cache.js";

const ELTON_BIRDS_URL = "https://figshare.com/ndownloader/files/5631081";

const FORAGING_STRATA = [
  "ForStrat-watbelowsurf",
  "ForStrat-wataroundsurf",
  "ForStrat-ground",
  "ForStrat-understory",
  "ForStrat-midhigh",
  "ForStrat-canopy",
  "ForStrat-aerial",
] as const;

export interface EltonTraitsRow {
  scientificName: string;
  dietMainCategory: string | null;
  foragingStratum: string | null;
  nocturnal: boolean | null;
}

function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i]?.trim() ?? ""));
    return row;
  });
}

function dominantStratum(row: Record<string, string>): string | null {
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const col of FORAGING_STRATA) {
    const v = Number(row[col]);
    if (Number.isFinite(v) && v > bestValue) {
      bestValue = v;
      best = col.replace("ForStrat-", "");
    }
  }
  return bestValue > 0 ? best : null;
}

export async function fetchEltonTraits(): Promise<EltonTraitsRow[]> {
  const filePath = await fetchCached("elton-traits", "BirdFuncDat.txt", ELTON_BIRDS_URL);
  const text = readFileSync(filePath, "utf-8");
  const rows = parseTsv(text);

  return rows.map((r) => ({
    scientificName: r["Scientific"] ?? "",
    dietMainCategory: r["Diet-5Cat"] || null,
    foragingStratum: dominantStratum(r),
    nocturnal: r["Nocturnal"] ? r["Nocturnal"] === "1" : null,
  }));
}

async function main() {
  const rows = await fetchEltonTraits();
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "elton-traits.json");
  writeFileSync(dest, JSON.stringify(rows, null, 2));
  console.log(`[elton-traits] wrote ${rows.length} rows to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
