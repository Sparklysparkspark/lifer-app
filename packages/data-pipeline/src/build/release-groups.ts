// Splits pack uploads across multiple rolling GitHub Releases instead of one — GitHub hard-caps
// a release at 1000 assets, and one "packs-latest" release for every sea-zone/country/taxon
// combination on Earth was always going to hit that ceiling (confirmed live: a routine country-
// pack rebuild died on a 422 "file_count limited to 1000 assets per release" once packs-latest
// reached 996). Packs now group by continent (one release per continent, e.g. "packs-europe"),
// with sea zones in their own "packs-seazones" bucket (a zone like the Red Sea doesn't belong to
// a single continent), while pack-index.json itself stays on the original "packs-latest" — the
// one URL apps/api/src/config.ts's PACK_INDEX_URL is hardcoded to, so that never needs to change.
// A downloading client only ever reads each pack's own `url` field out of pack-index.json (see
// build-pack-index.ts) and already trusts any github.com origin regardless of path
// (offlinePacks/routes.ts's assertTrustedPackUrl checks origin only) — so this split needed zero
// client-side changes.
import { execSync } from "node:child_process";
import { pool } from "../db.js";

export const GITHUB_REPO = "Sparklysparkspark/lifer-app";
export const INDEX_RELEASE_TAG = "packs-latest";

// GitHub's real hard cap is 1000 assets/release — staying under it with margin so a mid-flush
// crash can't leave a release sitting exactly at the edge the way packs-latest did.
const MAX_ASSETS_PER_RELEASE = 950;

const CONTINENT_SLUGS: Record<string, string> = {
  Africa: "africa",
  Antarctica: "antarctica",
  Asia: "asia",
  Europe: "europe",
  "North America": "north-america",
  Oceania: "oceania",
  "South America": "south-america",
  "Seven seas (open ocean)": "seven-seas",
};

let continentByCountryPromise: Promise<Map<string, string>> | null = null;

// One country -> continent-name lookup, built once per script run from the same region
// hierarchy the rest of the app already uses — a country's parent_id points straight at its
// continent (World -> continent -> country), same walk regions/routes.ts relies on elsewhere.
export function continentByCountry(): Promise<Map<string, string>> {
  if (!continentByCountryPromise) {
    continentByCountryPromise = pool
      .query<{ country: string; continent: string }>(
        `SELECT c.name AS country, p.name AS continent
         FROM regions c
         JOIN regions p ON p.id = c.parent_id
         WHERE p.parent_id = (SELECT id FROM regions WHERE name = 'World')`,
      )
      .then((res) => new Map(res.rows.map((r) => [r.country, r.continent])));
  }
  return continentByCountryPromise;
}

// The release a pack SHOULD live on, ignoring capacity — resolved to an actual numbered release
// (base, base-2, base-3, ...) by planReleaseAssignments below, the only place that needs to know
// about GitHub's asset cap.
export async function baseReleaseTagFor(pack: { type: "region" | "seaZone"; region?: string; seaZone?: string }): Promise<string> {
  if (pack.type === "seaZone") return "packs-seazones";
  const continents = await continentByCountry();
  const continent = pack.region ? continents.get(pack.region) : undefined;
  // Shouldn't normally happen — a computed country with no continent parent — but degrades to
  // its own small catch-all bucket rather than silently mis-filing into packs-latest again.
  if (!continent) return "packs-misc";
  return `packs-${CONTINENT_SLUGS[continent] ?? continent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function assetNamesOnRelease(tag: string): Set<string> | null {
  try {
    const out = execSync(`gh release view ${tag} --json assets --jq '.assets[].name'`, { encoding: "utf8" });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return null; // release doesn't exist yet
  }
}

// Assigns every (baseTag, fileName) pair to a specific numbered release under baseTag,
// preferring one that already has that exact filename (so a rebuilt pack replaces its
// predecessor in place — the original single-release design's "rolling, not append-only"
// behavior, preserved per continent) and otherwise the first release in the base/2/3/...
// sequence with room under MAX_ASSETS_PER_RELEASE, only creating a new numbered tag once every
// earlier one in the sequence is full.
export function planReleaseAssignments(items: Array<{ baseTag: string; fileName: string }>): Map<string, string> {
  const plan = new Map<string, string>();
  const assetCache = new Map<string, Set<string> | null>();
  const reserved = new Map<string, number>();
  const suffixByBase = new Map<string, number>();

  function assetsFor(tag: string): Set<string> | null {
    if (!assetCache.has(tag)) assetCache.set(tag, assetNamesOnRelease(tag));
    return assetCache.get(tag)!;
  }

  for (const { baseTag, fileName } of items) {
    let suffix = suffixByBase.get(baseTag) ?? 1;
    let tag = suffix === 1 ? baseTag : `${baseTag}-${suffix}`;
    let assets = assetsFor(tag);
    while (true) {
      const already = assets?.has(fileName) ?? false;
      const used = (assets?.size ?? 0) + (reserved.get(tag) ?? 0);
      if (already || used < MAX_ASSETS_PER_RELEASE) break;
      suffix++;
      tag = `${baseTag}-${suffix}`;
      assets = assetsFor(tag);
    }
    suffixByBase.set(baseTag, suffix);
    plan.set(fileName, tag);
    if (!(assets?.has(fileName) ?? false)) reserved.set(tag, (reserved.get(tag) ?? 0) + 1);
  }
  return plan;
}
