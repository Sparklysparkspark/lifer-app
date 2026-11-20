// Points each province's ebird_region_code at a region eBird knows. Codes came from ISO 3166, and
// eBird uses its own in places (CN-11 for Beijing, FR-ARA-38 for Isère); for a code it doesn't
// know eBird answers an empty list, so the province silently got no eBird species list or exotic
// status. Per country, from eBird's own subnational lists (cached in data/ebird-region-cache), a
// province's code is kept when eBird knows it, else replaced by the one eBird code ending the
// same way (FR-38 to FR-ARA-38), else by the one eBird region of the same name. Anything else is
// reported and left as it was: where eBird's regions don't line up with ours (Denmark's old
// counties, Vietnam's merged provinces) no code is right.
// Then fetches eBird's species list for every corrected code, and asks once more for any cached
// empty under a code eBird knows.
//
// Usage (from packages/data-pipeline):
//   npx tsx src/scripts/fix-ebird-region-codes.ts            (preview)
//   npx tsx src/scripts/fix-ebird-region-codes.ts --apply
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { PROVINCES_WITH_COUNTRY_SQL } from "@lifer/core/regions/regionTree.js";
import { ebirdGet } from "../regions/ebirdApi.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const CACHE_DIR = path.join(DATA_DIR, "ebird-region-cache");
const SPPLIST_DIR = path.join(DATA_DIR, "ebird-spplist-cache");

export interface EbirdRegion {
  code: string;
  name: string;
}

// Generic words around a name ("Dhaka bibhag", "Madrid, Comunidad de") aren't part of it.
const ADMIN_WORDS = /\b(bibhag|division|province|provincia|region|gouvernorat de|governorate|prefecture|state)\b/gi;
const normalize = (s: string) =>
  s
    .split(",")[0]
    .replace(ADMIN_WORDS, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The eBird code for one of our provinces, or null when none matches unambiguously. */
export function matchEbirdCode(ours: EbirdRegion, ebird: EbirdRegion[]): string | null {
  if (ebird.some((r) => r.code === ours.code)) return ours.code;
  const suffix = ours.code.slice(ours.code.indexOf("-") + 1);
  // Placeholder codes ("AU-X02~") have no real suffix to match.
  if (!suffix.includes("~")) {
    const bySuffix = ebird.filter((r) => r.code.split("-").at(-1) === suffix);
    if (bySuffix.length === 1) return bySuffix[0].code;
  }
  const byName = ebird.filter((r) => normalize(r.name) === normalize(ours.name));
  // A one-province community and its province share a name: the province is the finer match.
  const depth = (code: string) => code.split("-").length;
  const deepest = byName.filter((r) => depth(r.code) === Math.max(...byName.map((b) => depth(b.code))));
  return deepest.length === 1 ? deepest[0].code : null;
}

/** eBird's regions for a country, from the cache this script fills, or null before it has. */
export function cachedEbirdRegions(country: string): EbirdRegion[] | null {
  const file = path.join(CACHE_DIR, `${country}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** The eBird region whose exotic status a province goes by: its own code when eBird knows it, else
 *  the eBird region named like its group (an Italian province by its region), else its country.
 *  For exotic status only: a parent's species list would put birds on a province they were never
 *  seen in. */
export function exoticRegionCode(code: string, groupName: string | null, ebird: EbirdRegion[] | null): string | null {
  if (!ebird || ebird.some((r) => r.code === code)) return code;
  const country = code.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(country)) return null;
  const group = groupName
    ? ebird.filter((r) => r.code.split("-").length === 2 && normalize(r.name) === normalize(groupName))
    : [];
  return group.length === 1 ? group[0].code : country;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of items) out.set(key(t), [...(out.get(key(t)) ?? []), t]);
  return out;
}

async function ebirdRegions(country: string, key: string | undefined): Promise<EbirdRegion[] | null> {
  const file = path.join(CACHE_DIR, `${country}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!key) return null;
  const lists = await Promise.all(
    ["subnational1", "subnational2"].map((level) => ebirdGet<EbirdRegion>(`ref/region/list/${level}/${country}`, key)),
  );
  const regions = lists.flatMap((l) => l ?? []).map(({ code, name }) => ({ code, name }));
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(regions));
  return regions;
}

export async function fixEbirdRegionCodes(opts: { apply: boolean; log?: (m: string) => void }) {
  const log = opts.log ?? ((m) => console.log(`[ebird-codes] ${m}`));
  const key = process.env.EBIRD_API_KEY?.trim();
  if (!key) log("WARNING: EBIRD_API_KEY is not set; only cached eBird region lists are used");
  const provinces = (
    await pool.query<{ id: string; name: string; code: string }>(
      `SELECT r.id, r.name, r.ebird_region_code AS code FROM (${PROVINCES_WITH_COUNTRY_SQL}) p JOIN regions r ON r.id = p.id
       WHERE r.ebird_region_code ~ '^[A-Z]{2}-'`,
    )
  ).rows;
  const changes: Array<{ id: string; name: string; from: string; to: string }> = [];
  const unmatched: string[] = [];
  const known = new Set<string>();
  const byCountry = groupBy(provinces, (p) => p.code.slice(0, 2));
  for (const [country, list] of byCountry) {
    const ebird = await ebirdRegions(country, key);
    if (!ebird) continue;
    for (const r of ebird) known.add(r.code);
    const matched = list.map((p) => ({ p, to: matchEbirdCode(p, ebird) }));
    // Two provinces on one eBird region would share its list: neither gets it.
    const taken = groupBy(
      matched.filter((m) => m.to),
      (m) => m.to!,
    );
    for (const { p, to } of matched) {
      if (to === p.code) continue;
      if (!to || taken.get(to)!.length > 1) unmatched.push(`${p.code} ${p.name}`);
      else changes.push({ id: p.id, name: p.name, from: p.code, to });
    }
  }
  for (const c of changes) log(`${c.from} -> ${c.to} ${c.name}`);
  log(
    `${changes.length} codes corrected; ${unmatched.length} matching no single eBird region: ${unmatched.join(", ")}`,
  );

  // eBird's species list for each corrected code, and again for one cached empty under a code
  // eBird knows: answered while the hourly limit was spent, or legitimately empty. Each is asked
  // once (recorded in .rechecked.json), at eBird's pace, so a rerun carries on where this stopped.
  const recheckedFile = path.join(SPPLIST_DIR, ".rechecked.json");
  const rechecked = new Set<string>(existsSync(recheckedFile) ? JSON.parse(readFileSync(recheckedFile, "utf8")) : []);
  const codes = new Set(provinces.map((p) => changes.find((c) => c.id === p.id)?.to ?? p.code));
  const due = [...codes].filter((code) => {
    if (!known.has(code) || rechecked.has(code)) return false;
    const file = path.join(SPPLIST_DIR, `${code}.json`);
    return !existsSync(file) || readFileSync(file, "utf8").trim() === "[]";
  });
  let fetched = 0;
  if (key && opts.apply) {
    mkdirSync(SPPLIST_DIR, { recursive: true });
    for (const code of due) {
      try {
        const list = await ebirdGet<string>(`product/spplist/${code}`, key);
        if (list) writeFileSync(path.join(SPPLIST_DIR, `${code}.json`), JSON.stringify(list));
      } catch (err) {
        log(`eBird species lists stopped at ${code}, the rest next run: ${(err as Error).message}`);
        break;
      }
      rechecked.add(code);
      writeFileSync(recheckedFile, JSON.stringify([...rechecked]));
      if (++fetched % 100 === 0) log(`${fetched}/${due.length} eBird species lists fetched`);
    }
  }
  log(`${due.length} eBird species lists to fetch or ask again; ${fetched} fetched`);

  if (opts.apply && changes.length > 0)
    await pool.query(
      `UPDATE regions r SET ebird_region_code = v.code FROM unnest($1::uuid[], $2::text[]) AS v(id, code) WHERE r.id = v.id`,
      [changes.map((c) => c.id), changes.map((c) => c.to)],
    );
  log(opts.apply ? "applied" : "preview only (pass --apply)");
  return { changed: changes.length, unmatched: unmatched.length, spplists: fetched };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fixEbirdRegionCodes({ apply: process.argv.includes("--apply") })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
