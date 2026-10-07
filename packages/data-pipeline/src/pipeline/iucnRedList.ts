// The IUCN Red List as GBIF hosts it (dataset 19491596-35ae-4a91-9a98-85cf505f1bd3): one Darwin
// Core Archive of every assessed species, its synonyms and its global category, refreshed with
// each Red List version. One download (about 20 MB) instead of thousands of API pages, and the
// archive has stable IUCN taxon ids where the GBIF API's checklist keys change on every re-ingest
// (which is what broke the old backfill: its hardcoded Animalia key matched nothing).
//
// License: CC BY 4.0 on GBIF (the archive's EML); cite as the archive's own citation says.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeIucnStatus, type IucnCode } from "@lifer/shared";
import { RAW_DIR } from "@lifer/core/rawCache.js";

export const IUCN_DATASET_KEY = "19491596-35ae-4a91-9a98-85cf505f1bd3";
export const IUCN_ARCHIVE_URL = "https://hosted-datasets.gbif.org/datasets/iucn/iucn-latest.zip";
const ARCHIVE_PATH = path.join(RAW_DIR, "iucn-red-list", "iucn-latest.zip");
// IUCN publishes a new Red List version once or twice a year.
const ARCHIVE_MAX_AGE_DAYS = 30;

/** An assessed species: the accepted name and its global category. */
export interface IucnAccepted {
  taxonId: number;
  name: string;
  /** IUCN's class, upper case (AVES, REPTILIA, ...). */
  className: string;
  code: IucnCode;
}

/** A name IUCN lists as a synonym of an assessed species. `infraEpithet` is set when the synonym
 *  is a subspecies name ("Genus species ssp. epithet"): IUCN treats that taxon as part of the
 *  species, not as one of its own. */
export interface IucnSynonym {
  name: string;
  acceptedTaxonId: number;
  infraEpithet: string | null;
}

export interface IucnRedList {
  accepted: IucnAccepted[];
  synonyms: IucnSynonym[];
  /** The archive's citation line, e.g. "IUCN (2026). The IUCN Red List of Threatened Species.
   *  Version 2026-1. ..." */
  citation: string | null;
}

/** Downloads the archive unless a copy younger than ARCHIVE_MAX_AGE_DAYS is cached. */
export async function downloadIucnArchive(
  opts: { refresh?: boolean; log?: (m: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});
  const fresh =
    existsSync(ARCHIVE_PATH) && Date.now() - statSync(ARCHIVE_PATH).mtimeMs < ARCHIVE_MAX_AGE_DAYS * 86_400_000;
  if (fresh && !opts.refresh) {
    log(`using cached ${path.relative(process.cwd(), ARCHIVE_PATH)}`);
    return ARCHIVE_PATH;
  }
  log(`downloading ${IUCN_ARCHIVE_URL}`);
  const res = await fetch(IUCN_ARCHIVE_URL, {
    headers: { "User-Agent": "lifer-data-pipeline/0.1 (IUCN status backfill)" },
  });
  if (!res.ok) throw new Error(`IUCN archive download failed: ${res.status} ${res.statusText}`);
  mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  writeFileSync(ARCHIVE_PATH, Buffer.from(await res.arrayBuffer()));
  return ARCHIVE_PATH;
}

function readZipEntry(zipPath: string, entry: string): string {
  return execFileSync("unzip", ["-p", zipPath, entry], { maxBuffer: 1024 * 1024 * 1024 }).toString("utf8");
}

export function readIucnArchive(zipPath: string): IucnRedList {
  const eml = readZipEntry(zipPath, "eml.xml");
  const citation = /<citation>([^<]+)<\/citation>/.exec(eml)?.[1]?.trim() ?? null;
  return parseIucnArchive(readZipEntry(zipPath, "taxon.txt"), readZipEntry(zipPath, "distribution.txt"), citation);
}

// Column positions from the archive's meta.xml (taxon.txt and distribution.txt have no header).
const T = {
  id: 0,
  scientificName: 1,
  kingdom: 2,
  className: 4,
  genus: 7,
  epithet: 8,
  rank: 10,
  status: 12,
  accepted: 13,
};
const D = { id: 0, locality: 2, threatStatus: 5 };

// Lower-case author particles, so "Felis concolor de Blainville" isn't read as a trinomial.
const AUTHOR_PARTICLES = new Set([
  "de",
  "da",
  "del",
  "della",
  "der",
  "di",
  "du",
  "la",
  "le",
  "van",
  "von",
  "zu",
  "y",
  "in",
  "ex",
  "et",
  "d",
]);
const INFRA_MARKERS = new Set(["ssp.", "subsp.", "ssp", "subsp", "var.", "f.", "forma", "morph"]);

/** Canonical name of a full scientific name with authorship: "Genus epithet" plus the
 *  infraspecific epithet when there is one. Subgenera in parentheses are skipped. Null for
 *  anything that isn't a plain binomial or trinomial. */
export function parseScientificName(full: string): { binomial: string; infraEpithet: string | null } | null {
  const tokens = full.trim().split(/\s+/);
  const genus = tokens[0];
  if (!genus || !/^[A-Z][a-z-]+$/.test(genus)) return null;
  let i = 1;
  if (tokens[i]?.startsWith("(") && /^\([A-Z][a-z-]+\)$/.test(tokens[i])) i++;
  const epithet = tokens[i];
  if (!epithet || !/^[a-z][a-z-]+$/.test(epithet) || AUTHOR_PARTICLES.has(epithet)) return null;
  i++;
  const isEpithet = (t: string | undefined) => !!t && /^[a-z][a-z-]+$/.test(t) && !AUTHOR_PARTICLES.has(t);
  // "ssp." can come after the species' authorship ("Potamon gedrosianum Pretzmann, 1965 ssp.
  // waziristanis"), so it's looked for anywhere; without one, only a bare third epithet counts.
  const marker = tokens.findIndex((t, j) => j >= i && INFRA_MARKERS.has(t));
  const infraEpithet =
    marker >= 0 ? (isEpithet(tokens[marker + 1]) ? tokens[marker + 1] : null) : isEpithet(tokens[i]) ? tokens[i] : null;
  // A marker with no readable epithet after it is still not a species-level name.
  if (marker >= 0 && !infraEpithet) return null;
  return { binomial: `${genus} ${epithet}`, infraEpithet };
}

/** Parses the archive's taxon and distribution files. Animals only, species rank only. */
export function parseIucnArchive(
  taxonTsv: string,
  distributionTsv: string,
  citation: string | null = null,
): IucnRedList {
  // The archive has one distribution row per assessed taxon, locality "Global".
  const codeById = new Map<string, IucnCode>();
  for (const line of distributionTsv.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f[D.locality] && f[D.locality] !== "Global") continue;
    // The Lower Risk subcategories (1994 criteria) are the lower-case labels: "least concern" is
    // LR/lc, "near threatened" LR/nt, "conservation dependent" LR/cd. normalizeIucnStatus folds
    // the first two into LC and NT, which is how IUCN itself equates them.
    const code = normalizeIucnStatus(f[D.threatStatus]);
    if (code) codeById.set(f[D.id], code);
  }

  const accepted: IucnAccepted[] = [];
  const synonymRows: string[][] = [];
  for (const line of taxonTsv.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f[T.kingdom] !== "ANIMALIA") continue;
    if (f[T.status] === "synonym") {
      synonymRows.push(f);
      continue;
    }
    if (f[T.status] !== "accepted" || f[T.rank] !== "species") continue;
    const code = codeById.get(f[T.id]);
    if (!code || !f[T.genus] || !f[T.epithet]) continue;
    accepted.push({ taxonId: Number(f[T.id]), name: `${f[T.genus]} ${f[T.epithet]}`, className: f[T.className], code });
  }

  const acceptedIds = new Set(accepted.map((a) => a.taxonId));
  const synonyms: IucnSynonym[] = [];
  for (const f of synonymRows) {
    const acceptedTaxonId = Number(f[T.accepted]);
    if (!acceptedIds.has(acceptedTaxonId)) continue;
    const parsed = parseScientificName(f[T.scientificName]);
    if (!parsed) continue;
    synonyms.push({ name: parsed.binomial, acceptedTaxonId, infraEpithet: parsed.infraEpithet });
  }
  return { accepted, synonyms, citation };
}
