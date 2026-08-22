// Source: COMBINE (Soria et al. 2021, Ecology 102(6):e03344), via figshare
// (doi.org/10.6084/m9.figshare.13028255.v4). License: no copyright/proprietary restriction
// per the paper's data-availability statement (verified by hand); figshare's own API also
// reports CC-BY-4.0 for the record. This is mammals' AVONET-equivalent trait source per
// spec §7 ("COMBINE's density, home range, and nocturnality").
import { fetchCached } from "../raw-cache.js";
import { readFileSync } from "node:fs";

// figshare's ndownloader redirects to a signed S3 URL — fetch() follows redirects by
// default, so this stable URL is safe to hardcode; the download link itself would expire.
const COMBINE_REPORTED_URL = "https://ndownloader.figshare.com/files/27703263";

export interface CombineRow {
  scientificName: string;
  massG: number | null;
  homeRangeKm2: number | null;
  densityPerKm2: number | null;
  nocturnal: boolean | null;
  trophicLevel: number | null;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function num(value: string | undefined): number | null {
  if (!value || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchCombine(): Promise<CombineRow[]> {
  const filePath = await fetchCached("combine", "trait_data_reported.csv", COMBINE_REPORTED_URL);
  const rows = parseCsv(readFileSync(filePath, "utf-8"));

  const results = rows
    .map((row) => {
      const scientificName = row.iucn2020_binomial;
      if (!scientificName || scientificName === "NA") return null;
      // activity_cycle per COMBINE's own coding: 1 = nocturnal, 2 = cathemeral (both), 3 =
      // diurnal — collapsed to a boolean the same shape as EltonTraits' bird Nocturnal flag,
      // consistent with how compute-rarity-phase1.ts and the species card already use it.
      const activityCycle = num(row.activity_cycle);
      return {
        scientificName,
        massG: num(row.adult_mass_g),
        homeRangeKm2: num(row.home_range_km2),
        densityPerKm2: num(row.density_n_km2),
        nocturnal: activityCycle === 1 ? true : activityCycle === 3 ? false : null,
        trophicLevel: num(row.trophic_level),
      };
    })
    .filter((r): r is CombineRow => r !== null);

  console.log(`[combine] parsed ${results.length} mammal trait rows`);
  return results;
}
