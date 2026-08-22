// Source: "The global depth range of marine fishes and their genetic coverage for
// environmental DNA metabarcoding" (2023, Ecology and Evolution), data via Figshare
// (doi.org/10.6084/m9.figshare.20403111). License: CC-BY-4.0 (verified on the Figshare
// record page by hand, same standard applied to every other source in this project).
// Covers 10,826 Actinopterygii + 960 Chondrichthyes species (marine only — a real,
// disclosed gap: freshwater/brackish fish get no depth data from this source).
//
// Distributed only as an R .RData binary, no CSV/Excel alternative in the paper's
// supplementary materials (confirmed by hand). R must be installed on the machine running
// this fetcher (`brew install r`) to parse it — this fetcher shells out to Rscript once to
// export the two data frames inside to a CSV, then parses that CSV like every other source
// here. If R isn't installed, this throws with a clear message rather than failing inside a
// cryptic ENOENT.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchCached, RAW_DIR } from "../raw-cache.js";

const execFileAsync = promisify(execFile);
const DATA_URL = "https://ndownloader.figshare.com/files/38323722";

export interface FishDepthRow {
  scientificName: string;
  depthMinM: number;
  depthMaxM: number;
}

const R_EXPORT_SCRIPT = `
load("%RDATA%")
combined <- rbind(
  data.frame(Species=Actinopterygii$Species, Depth_min=Actinopterygii$Depth_min, Depth_max=Actinopterygii$Depth_max),
  data.frame(Species=Chondrichthyes$Species, Depth_min=Chondrichthyes$Depth_min, Depth_max=Chondrichthyes$Depth_max)
)
write.csv(combined, "%CSV%", row.names=FALSE, na="")
`;

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

export async function fetchFishDepth(): Promise<FishDepthRow[]> {
  const rdataPath = await fetchCached("fish-depth", "Data.RData", DATA_URL);
  const csvPath = path.join(RAW_DIR, "fish-depth", "depth_data.csv");

  if (!existsSync(csvPath)) {
    const scriptPath = path.join(RAW_DIR, "fish-depth", "export.R");
    writeFileSync(scriptPath, R_EXPORT_SCRIPT.replace("%RDATA%", rdataPath).replace("%CSV%", csvPath));
    try {
      await execFileAsync("Rscript", [scriptPath]);
    } catch (err) {
      throw new Error(
        `[fish-depth] Rscript failed — is R installed? (brew install r on macOS). Original error: ${err}`,
      );
    }
  }

  const lines = readFileSync(csvPath, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  const results: FishDepthRow[] = [];
  for (const line of lines.slice(1)) {
    const [species, depthMin, depthMax] = parseCsvLine(line);
    const depthMinM = Number(depthMin);
    const depthMaxM = Number(depthMax);
    if (!species || !Number.isFinite(depthMinM) || !Number.isFinite(depthMaxM)) continue;
    results.push({ scientificName: species, depthMinM, depthMaxM });
  }
  console.log(`[fish-depth] parsed ${results.length} species depth ranges`);
  return results;
}

async function main() {
  const rows = await fetchFishDepth();
  console.log(rows.slice(0, 5));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
