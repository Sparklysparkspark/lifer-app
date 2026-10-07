// Source: Mammal Diversity Database (MDD) v2.0, via Zenodo (doi.org/10.5281/zenodo.17033774).
// License: CC-BY-4.0. Mammals' AVONET equivalent: scientific names, curated common names,
// family/order and IUCN status in one file.
import { fetchCached, BUILD_DIR } from "@lifer/core/rawCache.js";
import path from "node:path";
import { readFileSync } from "node:fs";

const MDD_URL = "https://zenodo.org/records/15007505/files/MDD_v2.0_6759species.csv?download=1";

export interface MddRow {
  scientificName: string;
  commonName: string | null;
  family: string | null;
  order: string | null;
  // infraorder/superfamily, used to move marine mammals (whales, manatees, seals) into the "Fish"
  // group. MDD keeps "Cetacea" at infraorder rank (the order is "Artiodactyla") and groups all
  // pinnipeds under superfamily "Phocoidea".
  infraorder: string | null;
  superfamily: string | null;
  // MDD flag for fully domesticated forms (cattle, goats, dogs, ...). Citizen-science platforms
  // barely photograph farm animals, so they'd be mis-tiered as rare; domestic species are
  // excluded from region checklists instead.
  domestic: boolean;
  // MDD's cross-reference to Mammal Species of the World 3rd ed. GBIF's backbone often lags MDD by
  // this MSW3-era naming (e.g. "Bison bison" vs MDD's "Bos bison"), so it's a general fallback
  // join key for names the primary sciName misses.
  msw3Name: string | null;
}

// sciName is underscore-joined ("Genus_species"), converted to match GBIF's canonicalName join key.
function parseCsvLine(line: string): string[] {
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

export async function fetchMdd(): Promise<MddRow[]> {
  const filePath = await fetchCached("mdd", "MDD_v2.0_6759species.csv", MDD_URL);
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  const idx = (name: string) => headers.indexOf(name);
  const sciNameIdx = idx("sciName");
  const commonNameIdx = idx("mainCommonName");
  const familyIdx = idx("family");
  const orderIdx = idx("order");
  const infraorderIdx = idx("infraorder");
  const superfamilyIdx = idx("superfamily");
  const domesticIdx = idx("domestic");
  const msw3NameIdx = idx("MSW3_sciName");

  const rows: MddRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const rawName = cells[sciNameIdx];
    if (!rawName) continue;
    rows.push({
      scientificName: rawName.replace(/_/g, " "),
      commonName: cells[commonNameIdx] && cells[commonNameIdx] !== "NA" ? cells[commonNameIdx] : null,
      family: cells[familyIdx] && cells[familyIdx] !== "NA" ? cells[familyIdx] : null,
      order: cells[orderIdx] && cells[orderIdx] !== "NA" ? cells[orderIdx] : null,
      infraorder: cells[infraorderIdx] && cells[infraorderIdx] !== "NA" ? cells[infraorderIdx] : null,
      superfamily: cells[superfamilyIdx] && cells[superfamilyIdx] !== "NA" ? cells[superfamilyIdx] : null,
      domestic: cells[domesticIdx] === "1",
      msw3Name: cells[msw3NameIdx] && cells[msw3NameIdx] !== "NA" ? cells[msw3NameIdx].replace(/_/g, " ") : null,
    });
  }
  console.log(`[mdd] parsed ${rows.length} mammal species`);
  return rows;
}

async function main() {
  const rows = await fetchMdd();
  const dest = path.join(BUILD_DIR, "mdd.json");
  await import("node:fs").then((fs) => fs.writeFileSync(dest, JSON.stringify(rows.slice(0, 20), null, 2)));
  console.log(`[mdd] sample written to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
