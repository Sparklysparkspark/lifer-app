// Source: GBIF Backbone Taxonomy, via the public GBIF species API (api.gbif.org).
// License: CC0.
// Paginates species/search filtered to class Aves (classKey=212) and status=ACCEPTED,
// since synonyms and doubtful names would otherwise duplicate real species.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchWithRetry } from "../fetch-with-retry.js";

const GBIF_API = "https://api.gbif.org/v1/species/search";

// GBIF's backbone includes The Paleobiology Database, pure fossil taxa with no reliable
// `extinct` flag, making up over half of mammal backbone entries. Excluded for every taxon.
const PALEOBIOLOGY_DATABASE_CONSTITUENT_KEY = "c33ce2f2-c3cc-43a5-a380-fe4526d63650";
// A second fossil-only constituent (SNSB-JME's fossil fish list), excluded for the same reason.
const JURASSIC_PISCES_TETHYS_CONSTITUENT_KEY = "f5c60e9e-5b76-43b7-aa14-bbc3fa23b7d5";

export const AVES_CLASS_KEY = 212;
// Mammalia is a single clean class key, unlike fish (see fetch-fish-orders.ts).
export const MAMMALIA_CLASS_KEY = 359;
const PAGE_SIZE = 300;

export interface GbifSpeciesRow {
  gbifKey: number;
  scientificName: string;
  canonicalName: string | null;
  family: string | null;
  order: string | null;
}

interface GbifSearchResult {
  count: number;
  endOfRecords: boolean;
  results: Array<{
    key: number;
    scientificName: string;
    canonicalName?: string;
    family?: string;
    order?: string;
    rank: string;
    taxonomicStatus: string;
    nameType?: string;
    constituentKey?: string;
    extinct?: boolean;
  }>;
}

// Bony fish have no single class key in GBIF's backbone (no "Actinopterygii" class, just ~46
// orders under Chordata), so this takes a list of higher-taxon keys and unions the results,
// deduping by gbifKey since pages can overlap across keys.
export async function fetchGbifBackboneForKeys(higherTaxonKeys: number[]): Promise<GbifSpeciesRow[]> {
  const byGbifKey = new Map<number, GbifSpeciesRow>();

  for (const higherTaxonKey of higherTaxonKeys) {
    let offset = 0;
    for (;;) {
      const url = `${GBIF_API}?rank=SPECIES&status=ACCEPTED&highertaxonKey=${higherTaxonKey}&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetchWithRetry(url, {});
      if (!res.ok) {
        throw new Error(`[gbif] fetch failed: ${res.status} ${res.statusText} (${url})`);
      }
      const data = (await res.json()) as GbifSearchResult;

      for (const r of data.results) {
        if (r.rank !== "SPECIES" || r.taxonomicStatus !== "ACCEPTED") continue;
        // Exclude hybrids: a one-off cross isn't a species anyone can go looking for, and its tiny
        // record counts would skew rarity. GBIF flags them with `nameType: "HYBRID"`; the " x "
        // check guards against a missing nameType.
        if (r.nameType === "HYBRID" || / x /.test(r.scientificName)) continue;
        if (r.constituentKey === PALEOBIOLOGY_DATABASE_CONSTITUENT_KEY) continue;
        if (r.constituentKey === JURASSIC_PISCES_TETHYS_CONSTITUENT_KEY) continue;
        // "Genus spec" is fossil-checklist shorthand for "species indeterminate", not a real name.
        // Checked on the canonical name so longer epithets ending in "spec" don't match.
        if (/ spec$/.test(r.canonicalName ?? "")) continue;
        // Other constituents do populate `extinct` reliably, so those extinct entries are excluded too.
        if (r.extinct === true) continue;
        byGbifKey.set(r.key, {
          gbifKey: r.key,
          scientificName: r.scientificName,
          canonicalName: r.canonicalName ?? null,
          family: r.family ?? null,
          order: r.order ?? null,
        });
      }

      console.log(`[gbif] highertaxonKey=${higherTaxonKey}: fetched ${byGbifKey.size} total so far / ~${data.count} this key`);
      offset += PAGE_SIZE;
      if (data.endOfRecords || data.results.length === 0) break;
    }
  }

  return [...byGbifKey.values()];
}

export async function fetchGbifBackboneAves(): Promise<GbifSpeciesRow[]> {
  return fetchGbifBackboneForKeys([AVES_CLASS_KEY]);
}

interface GbifMatchResult {
  usageKey: number;
  scientificName: string;
  canonicalName?: string;
  family?: string;
  order?: string;
  rank: string;
  matchType: string;
}

/** For test/dev runs: resolve a handful of species by name instead of pulling the whole backbone. */
export async function fetchGbifSpeciesByNames(names: string[]): Promise<GbifSpeciesRow[]> {
  const rows: GbifSpeciesRow[] = [];
  for (const name of names) {
    const url = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}&rank=SPECIES&strict=true`;
    const res = await fetchWithRetry(url, {});
    if (!res.ok) {
      throw new Error(`[gbif] match failed for "${name}": ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GbifMatchResult;
    if (data.matchType === "NONE" || !data.usageKey) {
      console.warn(`[gbif] no match for "${name}" (matchType=${data.matchType})`);
      continue;
    }
    rows.push({
      gbifKey: data.usageKey,
      scientificName: data.scientificName,
      canonicalName: data.canonicalName ?? null,
      family: data.family ?? null,
      order: data.order ?? null,
    });
  }
  return rows;
}

async function main() {
  const rows = await fetchGbifBackboneAves();
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "gbif-backbone-aves.json");
  writeFileSync(dest, JSON.stringify(rows, null, 2));
  console.log(`[gbif] wrote ${rows.length} species to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
