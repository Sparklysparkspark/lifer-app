// The habitats WoRMS (World Register of Marine Species, marinespecies.org) records for a species,
// looked up by name in batches. Used by compute-sea-zones-offline.ts to keep freshwater-only
// species off sea zone checklists. WoRMS data is CC BY 4.0.

export const WORMS_API = "https://www.marinespecies.org/rest";
// AphiaRecordsByNames takes up to 50 names per request.
export const WORMS_BATCH_SIZE = 50;

export interface WormsEnvironment {
  aphiaId: number | null;
  marine: boolean | null;
  brackish: boolean | null;
  freshwater: boolean | null;
  terrestrial: boolean | null;
}

interface WormsRecord {
  AphiaID?: number;
  valid_AphiaID?: number | null;
  status?: string | null;
  rank?: string | null;
  isMarine?: number | null;
  isBrackish?: number | null;
  isFreshwater?: number | null;
  isTerrestrial?: number | null;
}

const flag = (v: number | null | undefined): boolean | null => (v == null ? null : v === 1);

/** One name's environment from its matches: the accepted species record if there is one, else
 *  the first match. No match gives null (WoRMS doesn't know the name). */
export function environmentFromRecords(records: WormsRecord[] | null | undefined): WormsEnvironment | null {
  if (!records || records.length === 0) return null;
  const chosen = records.find((r) => r.status === "accepted" && (r.rank ?? "Species") === "Species") ?? records[0];
  return {
    aphiaId: chosen.valid_AphiaID ?? chosen.AphiaID ?? null,
    marine: flag(chosen.isMarine),
    brackish: flag(chosen.isBrackish),
    freshwater: flag(chosen.isFreshwater),
    terrestrial: flag(chosen.isTerrestrial),
  };
}

/** True when WoRMS says the species lives only in fresh water or on land: never marine or
 *  brackish. Unknown flags are never treated as "not marine". */
export function isFreshwaterOrLandOnly(
  env: Pick<WormsEnvironment, "marine" | "brackish" | "freshwater" | "terrestrial">,
): boolean {
  if (env.marine === true || env.brackish === true) return false;
  if (env.marine == null && env.brackish == null) return false;
  return env.freshwater === true || env.terrestrial === true;
}

export function namesUrl(names: string[]): string {
  const query = names.map((n) => `scientificnames[]=${encodeURIComponent(n)}`).join("&");
  return `${WORMS_API}/AphiaRecordsByNames?${query}&like=false&marine_only=false`;
}

/** Looks up a batch of names; the result is aligned with `names`. Throws on a 429 or 5xx so the
 *  caller can back off; a 204 (no matches at all) gives every name null. */
export async function fetchEnvironments(
  names: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Array<WormsEnvironment | null>> {
  const res = await fetchImpl(namesUrl(names), { headers: { Accept: "application/json" } });
  if (res.status === 204) return names.map(() => null);
  if (!res.ok) throw Object.assign(new Error(`WoRMS answered HTTP ${res.status}`), { status: res.status });
  const body = (await res.json()) as Array<WormsRecord[] | null>;
  return names.map((_, i) => environmentFromRecords(body[i]));
}
