// Source: Natural Earth (naturalearthdata.com), via the maintainer's own GitHub GeoJSON
// mirror. License: public domain, any use. Deliberately NOT GADM, even though GADM is what
// build-region-species.ts already uses for GBIF occurrence-query codes — checked GADM's
// actual license by hand: non-commercial only. Using their code as a lookup key against
// GBIF's own API is fine; shipping their polygon *geometry* in a map would not be. Verified
// both files below are real and fetchable before writing this.

import { readFileSync } from "node:fs";
import { fetchCached } from "../raw-cache.js";

const ADMIN0_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
const ADMIN1_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";

export interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: unknown;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

// Memoized in-process: fetchProvincesForCountry is called once per region during a full
// drill-down sweep (thousands of calls in a single run — see compute-all-regions.ts /
// recompute-all-regions.ts), and this file is ~40MB — re-reading and re-JSON.parsing it from
// disk on every single call was turning an otherwise-instant local lookup into several minutes
// of redundant I/O and parsing over the course of one sweep.
let admin0Cache: Promise<GeoJsonFeatureCollection> | null = null;
let admin1Cache: Promise<GeoJsonFeatureCollection> | null = null;

async function loadAdmin0(): Promise<GeoJsonFeatureCollection> {
  if (!admin0Cache) {
    admin0Cache = fetchCached("natural-earth", "ne_10m_admin_0_countries.geojson", ADMIN0_URL).then(
      (path) => JSON.parse(readFileSync(path, "utf-8")) as GeoJsonFeatureCollection,
    );
  }
  return admin0Cache;
}

async function loadAdmin1(): Promise<GeoJsonFeatureCollection> {
  if (!admin1Cache) {
    admin1Cache = fetchCached("natural-earth", "ne_10m_admin_1_states_provinces.geojson", ADMIN1_URL).then(
      (path) => JSON.parse(readFileSync(path, "utf-8")) as GeoJsonFeatureCollection,
    );
  }
  return admin1Cache;
}

export interface CountryEntry {
  iso3: string; // Natural Earth's ADM0_A3, used as the GADM lookup key for GBIF queries too
  // ISO 3166-1 alpha-2 (Natural Earth's ISO_A2) — used for GBIF's `country` occurrence
  // filter, a DIFFERENT and broader signal than `gadmGid` (see build-region-species.ts's
  // gbifRegionParam: GADM's land administrative polygon for a country barely covers
  // territorial waters, so marine/coastal species get systematically undercounted through
  // gadmGid — confirmed for Egypt: country=EG's fish facet has 1,707 distinct species
  // vs gadmGid=EGY's 964, a 77% gap, matching real Red Sea estimates far better).
  iso2: string | null;
  name: string;
  continent: string;
  feature: GeoJsonFeature;
}

/** Every country in the world, grouped by continent — local file filtering, no network calls beyond the initial cache fetch. */
export async function fetchAllCountries(): Promise<CountryEntry[]> {
  const data = await loadAdmin0();
  return data.features
    .filter((f) => f.properties.ADM0_A3 && f.properties.NAME)
    .map((f) => ({
      iso3: f.properties.ADM0_A3 as string,
      iso2: (f.properties.ISO_A2 as string) ?? null,
      name: f.properties.NAME as string,
      continent: (f.properties.CONTINENT as string) ?? "Other",
      feature: f,
    }));
}

export interface ProvinceEntry {
  iso3166_2: string | null; // not every province has one in the source data
  name: string;
  feature: GeoJsonFeature;
}

/** All provinces/states for one country (Natural Earth's `adm0_a3` property), for lazy drill-down. */
export async function fetchProvincesForCountry(iso3: string): Promise<ProvinceEntry[]> {
  const data = await loadAdmin1();
  return data.features
    .filter((f) => f.properties.adm0_a3 === iso3 && f.properties.name)
    .map((f) => ({
      iso3166_2: (f.properties.iso_3166_2 as string) ?? null,
      name: f.properties.name as string,
      feature: f,
    }));
}
