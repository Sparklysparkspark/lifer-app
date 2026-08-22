// Source: AVONET (Tobias, J.A. et al. 2022, Ecology Letters 25(3), 581-597, DOI 10.1111/ele.13898).
// License: CC BY 4.0 — cite per lifer-spec.md §11.
// Figshare item 16586228 (verified by hand): the record zip contains
// "AVONET Supplementary dataset 1.xlsx" with sheets AVONET2_eBird (morphology, trophic niche,
// primary lifestyle, keyed to eBird/Clements names) and AVONET1_BirdLife (has Range.Size, but
// keyed to BirdLife names — eBird taxonomy has no range column of its own). We join the two via
// the workbook's own "BirdLife-eBird crosswalk" sheet to get range size onto eBird-named species.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { fetchCached, RAW_DIR, BUILD_DIR } from "../raw-cache.js";

const AVONET_RECORD_ZIP_URL = "https://figshare.com/ndownloader/articles/16586228/versions/7";
const WORKBOOK_NAME = "AVONET Supplementary dataset 1.xlsx";

export interface AvonetRow {
  scientificName: string; // eBird/Clements binomial (Species2)
  family: string | null;
  order: string | null;
  massG: number | null;
  wingLengthMm: number | null;
  tailLengthMm: number | null;
  tarsusLengthMm: number | null;
  beakLengthMm: number | null;
  handWingIndex: number | null;
  trophicNiche: string | null;
  primaryLifestyle: string | null;
  rangeSizeKm2: number | null;
  // Real, already-published AVONET fields, not previously extracted. Habitat is categorical
  // (Forest/Woodland/Shrubland/Grassland/Wetland/Riverine/Coastland/Marine/Desert/Human
  // Modified/Rock); habitatDensity is an ordinal 1 (dense/closed canopy) - 3 (open) — the
  // real signal for "detectability due to habitat cover," distinct from raw GBIF record
  // volume (which conflates observer frequency with how hard a species actually is to see).
  primaryHabitat: string | null;
  habitatDensity: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "object" && v !== null && "result" in v ? Number((v as { result: unknown }).result) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

function extractWorkbook(zipPath: string): string {
  const extractDir = path.join(RAW_DIR, "avonet", "extracted");
  const workbookPath = path.join(extractDir, WORKBOOK_NAME);
  if (!existsSync(workbookPath)) {
    mkdirSync(extractDir, { recursive: true });
    execFileSync("unzip", ["-o", zipPath, WORKBOOK_NAME, "-d", extractDir]);
  }
  return workbookPath;
}

/** Reads a worksheet into an array of {header: value} row objects, using row 1 as headers. */
function sheetToRows(sheet: ExcelJS.Worksheet): Record<string, unknown>[] {
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? "");
  });

  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (header) obj[header] = cell.value;
    });
    rows.push(obj);
  });
  return rows;
}

export async function fetchAvonet(): Promise<AvonetRow[]> {
  const zipPath = await fetchCached("avonet", "16586228.zip", AVONET_RECORD_ZIP_URL);
  const workbookPath = extractWorkbook(zipPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);

  const eBirdSheet = sheetToRows(workbook.getWorksheet("AVONET2_eBird")!);
  const birdLifeSheet = sheetToRows(workbook.getWorksheet("AVONET1_BirdLife")!);
  const crosswalkSheet = sheetToRows(workbook.getWorksheet("BirdLife-eBird crosswalk")!);

  const rangeByBirdLifeName = new Map<string, number | null>();
  for (const row of birdLifeSheet) {
    const name = str(row["Species1"]);
    if (name) rangeByBirdLifeName.set(name, num(row["Range.Size"]));
  }

  const birdLifeNameByEbirdName = new Map<string, string>();
  for (const row of crosswalkSheet) {
    const ebirdName = str(row["Species2"]);
    const birdLifeName = str(row["Species1"]);
    if (ebirdName && birdLifeName) birdLifeNameByEbirdName.set(ebirdName, birdLifeName);
  }

  return eBirdSheet.map((row) => {
    const scientificName = str(row["Species2"]) ?? "";
    const birdLifeName = birdLifeNameByEbirdName.get(scientificName);
    const rangeSizeKm2 = birdLifeName ? rangeByBirdLifeName.get(birdLifeName) ?? null : null;

    return {
      scientificName,
      family: str(row["Family2"]),
      order: str(row["Order2"]),
      massG: num(row["Mass"]),
      wingLengthMm: num(row["Wing.Length"]),
      tailLengthMm: num(row["Tail.Length"]),
      tarsusLengthMm: num(row["Tarsus.Length"]),
      beakLengthMm: num(row["Beak.Length_Culmen"]),
      handWingIndex: num(row["Hand-Wing.Index"]),
      trophicNiche: str(row["Trophic.Niche"]),
      primaryLifestyle: str(row["Primary.Lifestyle"]),
      rangeSizeKm2,
      primaryHabitat: str(row["Habitat"]),
      habitatDensity: num(row["Habitat.Density"]),
    };
  });
}

async function main() {
  const rows = await fetchAvonet();
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "avonet.json");
  writeFileSync(dest, JSON.stringify(rows, null, 2));
  const withRange = rows.filter((r) => r.rangeSizeKm2 != null).length;
  console.log(`[avonet] wrote ${rows.length} rows (${withRange} with a matched range size) to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
