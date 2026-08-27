// Source: GBIF Backbone Taxonomy, via the public GBIF species API (api.gbif.org).
// License: CC0 (per lifer-spec.md §5 — reverify on GBIF's own page before shipping, per §5 checklist).
// Paginates species/search filtered to class Aves (classKey=212) and status=ACCEPTED,
// since synonyms and doubtful names would otherwise duplicate real species.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchWithRetry } from "../fetch-with-retry.js";

const GBIF_API = "https://api.gbif.org/v1/species/search";

// GBIF's backbone merges in "The Paleobiology Database" — pure fossil/extinct taxa (e.g.
// "Diphydontosaurus avonis," an extinct Triassic sphenodontian) — as a constituent checklist
// alongside real modern taxonomy sources (Catalogue of Life, IUCN, WoRMS, etc.), with no
// reliable `extinct` flag to filter on instead (it's null even for obvious fossils). This
// constituent accounts for 12,087 of ~21,100 mammal backbone entries (57%!) — meaning over
// half of every mammal species this pipeline would otherwise load is an unphotographable
// fossil. Excluded here so every taxon built through fetchGbifBackboneForKeys (past and
// future) gets this for free.
const PALEOBIOLOGY_DATABASE_CONSTITUENT_KEY = "c33ce2f2-c3cc-43a5-a380-fe4526d63650";
// A second, smaller fossil-only constituent found the same way — GBIF's backbone also
// merges in a fish-fossil taxon list from Munich's SNSB-JME collection (mostly extinct
// Jurassic sharks/bony fish from the Tethys). Same reasoning as the PBDB exclusion above:
// real accepted names, `extinct` unreliable/null, but nothing anyone could ever photograph.
const JURASSIC_PISCES_TETHYS_CONSTITUENT_KEY = "f5c60e9e-5b76-43b7-aa14-bbc3fa23b7d5";

export const AVES_CLASS_KEY = 212;
// Verified via GBIF's own species/match API — Mammalia is a clean single class key, unlike
// fish (see fetch-fish-orders.ts).
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

// Phase 8: birds/mammals each have one clean GBIF class key (Aves=212, Mammalia=359), but
// bony fish do NOT — verified by hand against GBIF's backbone (species/44/children, i.e.
// Chordata's own children): there is no "Actinopterygii" class in GBIF's current backbone
// at all, just ~46 fish orders listed directly as Chordata's children alongside the
// tetrapod classes. So this takes a LIST of higher-taxon keys (one classKey for birds/
// mammals, many orderKeys for fish — see fetch-fish-orders.ts) and unions the results,
// deduping by gbifKey since GBIF's paging can't be trusted not to overlap across keys.
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
        // Exclude hybrids (spec §7's rarity model implicitly assumes real, findable
        // populations — a hybrid like "Cygnus cygnus x olor" is a one-off cross, not a
        // species anyone can realistically go looking for, and its noisy/tiny GBIF
        // occurrence counts would otherwise skew rarity for nothing). GBIF's own API flags
        // these via `nameType: "HYBRID"`; also guard on the literal " x " naming convention
        // in case nameType is ever missing from a result.
        if (r.nameType === "HYBRID" || / x /.test(r.scientificName)) continue;
        if (r.constituentKey === PALEOBIOLOGY_DATABASE_CONSTITUENT_KEY) continue;
        if (r.constituentKey === JURASSIC_PISCES_TETHYS_CONSTITUENT_KEY) continue;
        // "Genus spec" (e.g. "Bos spec") is paleontology shorthand for "species
        // indeterminate" — a placeholder some fossil checklists use in place of a real
        // binomial, not an actual species name. Checked on the canonical name specifically
        // (genus + epithet, no author string) so a real epithet that happens to end in
        // "spec" as part of a longer word can't false-positive.
        if (/ spec$/.test(r.canonicalName ?? "")) continue;
        // The Paleobiology Database exclusion above only catches ITS fossils — its own
        // `extinct` field is unreliable/null even for obvious cases (why the constituentKey
        // check exists at all). But OTHER constituents (e.g. "German Wikipedia - Species
        // Pages") DO populate `extinct` reliably (e.g. Adalatherium hui, an extinct
        // Madagascar mammal), so those fossil/extinct entries need their own exclusion here.
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
