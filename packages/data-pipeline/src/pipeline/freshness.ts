// Whether the stages a publish ships were rerun since what they read last changed. The gate checks
// data shape; this catches a `--stages=packs,gate,publish` run shipping tiers or checklists an
// older run wrote from older inputs.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const GBIF_CACHE_DIR = path.join(DATA_DIR, "gbif-country-cache");
const ZIP_NAMES = path.join(DATA_DIR, "build", "zip-names.tsv");

export const FRESH_STAGES = ["catalog", "regions", "endemic", "tiers", "vectors"] as const;
export type FreshStage = (typeof FRESH_STAGES)[number];

type InputFile = "gbifDownloads" | "zipNames";
// What each stage reads that another stage or a download can change. A sea-zone-only regions run
// (--replace-sea-zones) rebuilds no checklist, so it counts as neither a regions run nor an input.
const INPUTS: Record<FreshStage, { stages: string[]; files: InputFile[] }> = {
  catalog: { stages: [], files: ["zipNames"] },
  regions: { stages: [], files: ["gbifDownloads"] },
  endemic: { stages: [], files: ["gbifDownloads"] },
  tiers: { stages: ["regions"], files: ["gbifDownloads"] },
  vectors: { stages: ["catalog", "enrich"], files: [] },
};

/** The newest `done` finish of each stage. */
export type StageTimes = Map<string, Date>;

/** Each stale stage and why. */
export function staleStages(times: StageTimes, files: Partial<Record<InputFile, Date>>): Map<FreshStage, string> {
  const stale = new Map<FreshStage, string>();
  for (const stage of FRESH_STAGES) {
    const at = times.get(stage);
    if (!at) {
      stale.set(stage, `${stage} has never finished`);
      continue;
    }
    for (const up of INPUTS[stage].stages) {
      const upAt = times.get(up);
      if (upAt && upAt > at) stale.set(stage, `${stage} (${iso(at)}) is older than ${up} (${iso(upAt)})`);
    }
    for (const f of INPUTS[stage].files) {
      const fAt = files[f];
      if (fAt && fAt > at) stale.set(stage, `${stage} (${iso(at)}) is older than ${FILE_LABEL[f]} (${iso(fAt)})`);
    }
  }
  return stale;
}

const FILE_LABEL: Record<InputFile, string> = {
  gbifDownloads: "the newest GBIF country download",
  zipNames: "the GBIF name list",
};
const iso = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export async function loadStageTimes(pool: Pool): Promise<StageTimes> {
  const res = await pool.query<{ stage: string; at: Date }>(
    `SELECT stage, max(finished_at) AS at FROM pipeline_runs
     WHERE item = '' AND status = 'done' AND finished_at IS NOT NULL
       AND NOT COALESCE((notes->>'seaZonesOnly')::boolean, false)
     GROUP BY stage`,
  );
  return new Map(res.rows.map((r) => [r.stage, r.at]));
}

export function inputFileTimes(): Partial<Record<InputFile, Date>> {
  const out: Partial<Record<InputFile, Date>> = {};
  if (existsSync(GBIF_CACHE_DIR)) {
    const newest = Math.max(
      0,
      ...readdirSync(GBIF_CACHE_DIR)
        .filter((f) => f.endsWith(".zip"))
        .map((f) => statSync(path.join(GBIF_CACHE_DIR, f)).mtimeMs),
    );
    if (newest > 0) out.gbifDownloads = new Date(newest);
  }
  if (existsSync(ZIP_NAMES)) out.zipNames = statSync(ZIP_NAMES).mtime;
  return out;
}
