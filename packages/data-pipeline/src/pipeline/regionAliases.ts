// Other names a region is known by (data/reference/region-aliases.json), stored in
// regions.aliases for the app's region search. Names are matched without accents or case.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

type Db = Pick<Pool | PoolClient, "query">;

export interface AliasEntry {
  /** Names the region may carry in the catalog, tried in order. */
  match: string[];
  aliases: string[];
}

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.']/g, "").trim();

export function loadAliasEntries(): AliasEntry[] {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../data/reference/region-aliases.json");
  return JSON.parse(readFileSync(file, "utf-8")) as AliasEntry[];
}

export interface NamedRegion {
  id: string;
  name: string;
  parentId: string | null;
}

export interface AliasPlan {
  /** Region id to its alias list. */
  aliases: Map<string, string[]>;
  /** Entries whose names match no region. */
  unmatched: string[][];
  /** An alias that is another region's own name (it would find two regions). */
  clashes: string[];
}

/** Resolves each entry to one region: the first listed name that exists, preferring the highest
 *  level (a country over a same-named province). An alias never repeats the region's own name. */
export function planAliases(regions: NamedRegion[], entries: AliasEntry[]): AliasPlan {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const level = (r: NamedRegion) => {
    let d = 0;
    for (let p = r; p.parentId && byId.has(p.parentId); p = byId.get(p.parentId)!) d++;
    return d;
  };
  const byName = new Map<string, NamedRegion[]>();
  for (const r of regions) byName.set(fold(r.name), [...(byName.get(fold(r.name)) ?? []), r]);
  const plan: AliasPlan = { aliases: new Map(), unmatched: [], clashes: [] };
  for (const entry of entries) {
    const target = entry.match
      .map((n) => (byName.get(fold(n)) ?? []).sort((a, b) => level(a) - level(b))[0])
      .find((r) => r !== undefined);
    if (!target) {
      plan.unmatched.push(entry.match);
      continue;
    }
    const kept = entry.aliases.filter((a) => {
      if (fold(a) === fold(target.name)) return false;
      const owners = byName.get(fold(a)) ?? [];
      // Another country-level name would make the alias find two regions.
      if (owners.some((o) => o.id !== target.id && level(o) <= level(target))) {
        plan.clashes.push(`${a} (${target.name})`);
        return false;
      }
      return true;
    });
    plan.aliases.set(target.id, [...new Set([...(plan.aliases.get(target.id) ?? []), ...kept])]);
  }
  return plan;
}

/** Countries sharing one name: the duplicate rows (a territory listed under two parents) to merge. */
export function duplicateCountries(regions: NamedRegion[]): string[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const seen = new Map<string, number>();
  for (const r of regions) {
    const continent = r.parentId ? byId.get(r.parentId) : undefined;
    if (continent?.parentId && byId.get(continent.parentId)?.parentId === null)
      seen.set(fold(r.name), (seen.get(fold(r.name)) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
}

export interface AliasResult extends Omit<AliasPlan, "aliases"> {
  written: number;
  duplicates: string[];
}

/** Stores the aliases, touching only regions whose list changed. */
export async function applyAliases(db: Db, entries: AliasEntry[] = loadAliasEntries()): Promise<AliasResult> {
  const rows = (
    await db.query<{ id: string; name: string; parent_id: string | null; aliases: string[] }>(
      `SELECT id, name, parent_id, aliases FROM regions`,
    )
  ).rows;
  const regions = rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
  const plan = planAliases(regions, entries);
  let written = 0;
  for (const r of rows) {
    const next = plan.aliases.get(r.id) ?? [];
    if (next.length === r.aliases.length && next.every((a, i) => a === r.aliases[i])) continue;
    await db.query(`UPDATE regions SET aliases = $2 WHERE id = $1`, [r.id, next]);
    written++;
  }
  return { written, unmatched: plan.unmatched, clashes: plan.clashes, duplicates: duplicateCountries(regions) };
}
