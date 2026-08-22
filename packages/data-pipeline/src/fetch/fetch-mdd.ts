// Source: Mammal Diversity Database (MDD) v2.0, via Zenodo (doi.org/10.5281/zenodo.17033774).
// License: CC-BY-4.0 (verified on the Zenodo record page by hand, same standard applied to
// every other data source in this project — see AVONET/EltonTraits/Natural Earth). This is
// mammals' AVONET-equivalent taxonomy source: real scientific names, curated common names,
// family/order, and IUCN status all in one file — richer than what GBIF's own vernacular
// names endpoint gives per-species for birds.
import { fetchCached, BUILD_DIR } from "../raw-cache.js";
import path from "node:path";
import { readFileSync } from "node:fs";

const MDD_URL = "https://zenodo.org/records/15007505/files/MDD_v2.0_6759species.csv?download=1";

export interface MddRow {
  scientificName: string;
  commonName: string | null;
  family: string | null;
  order: string | null;
  // infraorder/superfamily — used to pull obligate/predominantly marine mammals (whales,
  // manatees, seals) into the app's "Fish" taxon grouping. MDD keeps "Cetacea" at infraorder
  // rank (order itself is the merged "Artiodactyla" in modern taxonomy) and groups all
  // pinnipeds under superfamily "Phocoidea", verified by hand against the actual file for
  // representative species in each group.
  infraorder: string | null;
  superfamily: string | null;
  // Real MDD flag (not a guess/curated list) marking fully domesticated forms (cattle,
  // goats, sheep, domestic dog/cat, etc.). Without this, these species would show up as
  // "rare"/"epic" in region checklists purely because citizen-science platforms like
  // iNaturalist barely ever get farm-animal photos relative to how common they actually
  // are, an effort-bias artifact with the opposite sign from the wild-species case. A
  // life-list app has no use for "you photographed a cow," so domestic species are
  // excluded from region checklists entirely rather than mis-tiered.
  domestic: boolean;
  // MDD's own cross-reference to Mammal Species of the World 3rd ed. This is needed because
  // GBIF's backbone still carries the older "Bison bison" name for American Bison, while
  // MDD's own primary sciName has already followed the Bos/Bison genus merge to "Bos bison",
  // so the primary-name join silently misses and the species shows up with no common name at
  // all. GBIF's taxonomy generally lags behind MDD by roughly this same MSW3-era lineage, so
  // this is a real, general fallback key, not a one-off patch for bison alone (649 of 6759
  // MDD rows have a MSW3 name that differs from their primary sciName).
  msw3Name: string | null;
}

// Real column layout, verified against the actual file: sciName is underscore-joined
// ("Genus_species", not "Genus species") — converted here so it lines up with GBIF's
// canonicalName join key used everywhere else in this pipeline.
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
      msw3Name:
        cells[msw3NameIdx] && cells[msw3NameIdx] !== "NA" ? cells[msw3NameIdx].replace(/_/g, " ") : null,
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
