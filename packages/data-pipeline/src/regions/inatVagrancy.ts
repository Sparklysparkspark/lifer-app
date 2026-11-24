// iNaturalist decides whether a species is on a region's list and whether it's a vagrant there;
// GBIF only corroborates. The rules, kept pure for apply-inat-membership.ts and its tests.
//
// Membership: at least one research-grade observation in the region's iNaturalist place. Research
// grade needs a photo and two agreeing identifiers and leaves out captive animals, so one is real
// evidence; telling a stray from a resident is the vagrant rule's job, not membership's. Missing
// from the place counts as absent only where iNaturalist observers cover the species' group
// (WELL_OBSERVED_GROUP_OBS research-grade observations of it there); elsewhere iNaturalist hasn't
// looked, and unknown is not absent.
//
// Vagrant: a stray that birders chase piles up observations in a single season (Great Kiskadee in
// Canada: 46 observations, all in 2018), so counts mislead and the spread over years decides. A
// bird seen in at most VAGRANT_MAX_YEARS of the last VAGRANT_WINDOW_YEARS complete years is a
// vagrant; seen in more, it's regular there, however scarce. Only a place well observed for birds
// can tell; elsewhere iNaturalist is unsure, a province takes its country's call, and failing
// that GBIF's recurrence check (the row's existing flag) stands. Birds only: a deep-lake fish, a
// vole or a bat goes years unphotographed in its own range.

export const VAGRANT_WINDOW_YEARS = 10;
export const VAGRANT_MAX_YEARS = 2;
// Above this many observations a species is regular without asking for its years.
export const VAGRANT_CANDIDATE_MAX_OBS = 1000;
export const WELL_OBSERVED_GROUP_OBS = 20_000;

export type InatVagrancy = "vagrant" | "resident" | "unsure";

/** The complete calendar years the vagrant rule looks at, oldest first. */
export function vagrantWindowYears(now = new Date()): number[] {
  const end = now.getFullYear();
  return Array.from({ length: VAGRANT_WINDOW_YEARS }, (_, i) => end - VAGRANT_WINDOW_YEARS + i);
}

// Catalog taxon classes to iNaturalist's iconic groups, for species a place has no record of.
const ICONIC_BY_CLASS: Record<string, string> = {
  aves: "Aves",
  mammalia: "Mammalia",
  actinopterygii: "Actinopterygii",
  amphibia: "Amphibia",
  squamata: "Reptilia",
  testudines: "Reptilia",
  marine_mollusks: "Mollusca",
  nudibranchs: "Mollusca",
  cephalopoda: "Mollusca",
};

export function iconicOfClass(taxonClass: string | null): string {
  return ICONIC_BY_CLASS[taxonClass ?? ""] ?? "Animalia";
}

/** Whether a bird's years in this place can call it a vagrant. */
export function yearsDecide(iconic: string | null, groupObs: number): boolean {
  return iconic === "Aves" && groupObs >= WELL_OBSERVED_GROUP_OBS;
}

/** iNaturalist's call for one species in one place. `yearsPresent` is null when its years
 *  weren't fetched; `groupObs` is the place's research-grade observations of its iconic group. */
export function inatVagrancy(o: {
  observations: number;
  yearsPresent: number | null;
  iconic: string | null;
  groupObs: number;
}): InatVagrancy {
  if (o.observations > VAGRANT_CANDIDATE_MAX_OBS) return "resident";
  if (!yearsDecide(o.iconic, o.groupObs) || o.yearsPresent == null) return "unsure";
  return o.yearsPresent <= VAGRANT_MAX_YEARS ? "vagrant" : "resident";
}

/** The listing's flag. GBIF (the existing flag, from its recurrence check and range checklists)
 *  only decides when iNaturalist is unsure, so it can back a vagrant call but never overturn one.
 *  A hand-checked override wins, introduced listings keep the flag apply-introduced-flags.ts set,
 *  and farm animals are never vagrants. */
export function decideIsVagrant(o: {
  inat: InatVagrancy;
  current: boolean;
  override: boolean | null;
  introduced: boolean;
  domestic: boolean;
}): boolean {
  if (o.override != null) return o.override;
  if (o.introduced) return o.current;
  if (o.domestic) return false;
  if (o.inat === "unsure") return o.current;
  return o.inat === "vagrant";
}
