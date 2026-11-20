// Standalone mode: checklists from the public pack index (the file the desktop downloads). The index
// is fetched only when the person asks. It lists each region's species by scientific name, in one
// pack per kind of animal; common names come when the phone pairs with a Lifer.
import type { RegionSpecies } from "../store/regions";

export const PACK_INDEX_URL =
  "https://github.com/Sparklysparkspark/lifer-app/releases/download/packs-latest/pack-index.json";

interface IndexPack {
  id: string;
  type: string;
  region?: string;
  taxon?: string | null;
  variant?: string;
  scientificNames: string[];
}
export interface PackIndex {
  generatedAt: string;
  packs: IndexPack[];
}

export function parsePackIndex(text: string): PackIndex | null {
  try {
    const o = JSON.parse(text) as PackIndex;
    if (typeof o?.generatedAt !== "string" || !Array.isArray(o.packs)) return null;
    return o.packs.every((p) => typeof p?.id === "string" && Array.isArray(p.scientificNames)) ? o : null;
  } catch {
    return null;
  }
}

export interface PackRegion {
  name: string;
  speciesCount: number;
}

const regionPacks = (index: PackIndex, name: string) =>
  index.packs.filter((p) => p.type === "region" && p.region === name && p.variant !== "small");

/** Countries and territories with a checklist, biggest lists included; sorted by name. */
export function listPackRegions(index: PackIndex): PackRegion[] {
  const names = new Map<string, Set<string>>();
  for (const p of index.packs) {
    if (p.type !== "region" || !p.region || p.variant === "small") continue;
    const set = names.get(p.region) ?? new Set<string>();
    for (const n of p.scientificNames) set.add(n);
    names.set(p.region, set);
  }
  return [...names.entries()]
    .map(([name, set]) => ({ name, speciesCount: set.size }))
    .filter((r) => r.speciesCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function packChecklist(index: PackIndex, name: string): RegionSpecies[] {
  const seen = new Map<string, RegionSpecies>();
  for (const p of regionPacks(index, name))
    for (const n of p.scientificNames)
      if (!seen.has(n))
        seen.set(n, {
          scientificName: n,
          commonName: null,
          taxonClass: p.taxon ?? null,
          tier: null,
          vagrant: false,
          sensitive: false,
        });
  return [...seen.values()];
}

/** The region whose name is the country a reverse lookup found (case and accents ignored), or null. */
export function regionForCountry(regions: PackRegion[], country: string | null): PackRegion | null {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  const want = country ? norm(country) : "";
  return want ? (regions.find((r) => norm(r.name) === want) ?? null) : null;
}
