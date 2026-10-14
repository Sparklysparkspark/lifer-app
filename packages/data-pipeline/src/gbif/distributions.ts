// Where GBIF's checklists say a species is native or introduced, by country (species/{key}/
// distributions). Introduced countries come from GRIIS alone, the Global Register of Introduced
// and Invasive Species, curated country by country for every group: other checklists there mark a
// move within a native country, or a whole native range, as introduced. Cached per GBIF key on
// disk, so a rerun only asks about species it hasn't seen.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpFetch } from "@lifer/core/lib/http.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";

const CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "gbif-establishment-cache.json",
);
const CACHE_MAX_AGE_MS = 365 * 86_400_000;
const CONCURRENCY = 8;
const SAVE_EVERY = 500;

export interface CountryEstablishment {
  /** ISO 3166-1 alpha-2 codes. */
  native: string[];
  introduced: string[];
}

interface CacheEntry extends CountryEstablishment {
  at: number;
}

interface GbifDistribution {
  country?: string;
  locationId?: string;
  establishmentMeans?: string;
  source?: string;
}

const INTRODUCED_SOURCE = /^Global Register of Introduced and Invasive Species/;

/** The countries a species' distribution records name as native or introduced. */
export function establishmentFromDistributions(records: GbifDistribution[]): CountryEstablishment {
  const native = new Set<string>();
  const introduced = new Set<string>();
  for (const d of records) {
    const iso2 = (d.country ?? /^iso:([a-z]{2})$/i.exec(d.locationId ?? "")?.[1] ?? "").toUpperCase();
    if (iso2.length !== 2) continue;
    const means = d.establishmentMeans?.toUpperCase();
    if (means === "NATIVE" || means === "ENDEMIC") native.add(iso2);
    else if (
      (means === "INTRODUCED" || means === "NATURALISED" || means === "INVASIVE") &&
      INTRODUCED_SOURCE.test(d.source ?? "")
    )
      introduced.add(iso2);
  }
  return { native: [...native], introduced: [...introduced] };
}

async function fetchEstablishment(gbifKey: number): Promise<CountryEstablishment | null> {
  const records: GbifDistribution[] = [];
  for (let offset = 0; ; offset += 200) {
    const res = await httpFetch(`https://api.gbif.org/v1/species/${gbifKey}/distributions?limit=200&offset=${offset}`, {
      maxRetries: 4,
      retryServerErrors: true,
    });
    if (!res.ok) return null;
    const page = (await res.json()) as { results: GbifDistribution[]; endOfRecords: boolean };
    records.push(...page.results);
    if (page.endOfRecords) break;
  }
  return establishmentFromDistributions(records);
}

/** Each species' native and introduced countries, from the cache or GBIF. A species whose lookup
 *  failed is left out, so it's treated as having no record either way. */
export async function countryEstablishment(
  gbifKeys: number[],
  log: (m: string) => void,
): Promise<Map<number, CountryEstablishment>> {
  const cache: Record<string, CacheEntry> = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
  const save = () => {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  };
  const stale = gbifKeys.filter((k) => !cache[k] || Date.now() - cache[k].at > CACHE_MAX_AGE_MS);
  if (stale.length > 0) log(`asking GBIF where ${stale.length} species are native or introduced`);
  let done = 0;
  let failed = 0;
  await mapWithConcurrency(stale, CONCURRENCY, async (key) => {
    const found = await fetchEstablishment(key).catch(() => null);
    if (found) cache[key] = { ...found, at: Date.now() };
    else failed++;
    if (++done % SAVE_EVERY === 0) {
      save();
      log(`  ${done}/${stale.length}`);
    }
  });
  if (stale.length > 0) save();
  if (failed > 0) log(`  ${failed} lookups failed; those species are judged on records alone`);
  const out = new Map<number, CountryEstablishment>();
  for (const k of gbifKeys) if (cache[k]) out.set(k, { native: cache[k].native, introduced: cache[k].introduced });
  return out;
}
