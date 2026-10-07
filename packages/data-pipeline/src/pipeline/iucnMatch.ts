// Matches catalog species to IUCN Red List assessments (iucnRedList.ts), and decides what to
// store for each. Pure: no database, no network.
//
// Matching, most trusted first. A species stops at the first step that finds anything:
//   name             its scientific name is an assessed species' accepted name
//   synonym          its name is one IUCN lists as a synonym of an assessed species
//   catalog_synonym  one of its own synonyms (species_synonyms) is an assessed species' name, or
//                    one of IUCN's synonyms
//   gbif_key         GBIF links its backbone key to an IUCN assessment (looked up live, only for
//                    species the name steps missed; see iucnBackfill.ts)
//   spelling         same genus, epithet differing only in its Latin ending (alba/albus,
//                    nigra/niger, bairdi/bairdii), the usual trace of a genus move
// Every step only counts an assessment in a compatible class (a bird never takes a snail's
// status), and a name that leads to more than one assessed species is ambiguous, not a match.
//
// Splits. When a species reaches an assessment only indirectly and that assessment is the
// direct match of another catalog species, or several catalog species reach the same one, the
// catalog splits what IUCN still assesses as one species. The parent's status is about a
// different, larger population, so it isn't inherited: the species is Not Evaluated with a note
// naming the parent. The same goes for a species IUCN lists as a subspecies of another, and for a
// recorded split (species_splits) whose daughter IUCN hasn't assessed.
import { IUCN_NAMES, type IucnCode, type IucnSource } from "@lifer/shared";
import type { IucnAccepted, IucnRedList } from "./iucnRedList.js";

export type IucnMatchMethod = "name" | "synonym" | "catalog_synonym" | "gbif_key" | "spelling";

export type IucnMatch =
  | {
      kind: "assessed";
      method: IucnMatchMethod;
      taxonId: number;
      code: IucnCode;
      iucnName: string;
      /** Another catalog species has this assessment's exact name and the same epithet: likely one
       *  species entered twice (an old and a new genus), worth a species-merges review. */
      duplicateOf?: string;
    }
  | {
      kind: "part_of";
      via: "lumped" | "subspecies" | "split";
      taxonId: number;
      parentName: string;
      parentCode: IucnCode;
    }
  | { kind: "none"; ambiguous: boolean };

export interface IucnCatalogSpecies {
  id: string;
  scientificName: string;
  taxonClass: string;
  /** Other names for it (species_synonyms). */
  synonyms?: string[];
  /** The species it was split from (species_splits), when recorded. */
  splitFromName?: string | null;
  /** The IUCN taxon id GBIF links its backbone key to, when that was looked up. */
  gbifIucnTaxonId?: number | null;
  /** GBIF looked its backbone key up and found no assessment either. */
  gbifNotEvaluated?: boolean;
}

// Catalog group to the IUCN classes its species can be in. A group not listed (Other Taxa)
// accepts any class.
const IUCN_CLASSES_BY_TAXON_CLASS: Record<string, string[]> = {
  aves: ["AVES"],
  mammalia: ["MAMMALIA"],
  aquatic_mammalia: ["MAMMALIA"],
  actinopterygii: ["ACTINOPTERYGII", "SARCOPTERYGII", "MYXINI", "PETROMYZONTI", "CEPHALASPIDOMORPHI"],
  elasmobranchii: ["CHONDRICHTHYES"],
  amphibia: ["AMPHIBIA"],
  squamata: ["REPTILIA"],
  testudines: ["REPTILIA"],
  corals: ["ANTHOZOA", "HYDROZOA"],
  jellies_and_anemones: ["ANTHOZOA", "HYDROZOA", "SCYPHOZOA", "CUBOZOA", "STAUROZOA"],
  echinodermata: ["ASTEROIDEA", "ECHINOIDEA", "HOLOTHUROIDEA", "CRINOIDEA", "OPHIUROIDEA"],
  nudibranchs: ["GASTROPODA"],
  marine_mollusks: ["GASTROPODA", "BIVALVIA", "POLYPLACOPHORA", "SCAPHOPODA", "MONOPLACOPHORA", "SOLENOGASTRES"],
  cephalopoda: ["CEPHALOPODA"],
  crustacea: ["MALACOSTRACA", "MAXILLOPODA", "BRANCHIOPODA", "HEXANAUPLIA", "OSTRACODA", "THECOSTRACA", "THEOCOSTRACA"],
  sponges_tunicates_other: ["DEMOSPONGIAE", "CALCAREA", "HEXACTINELLIDA", "HOMOSCLEROMORPHA", "ASCIDIACEA"],
};

/** Groups IUCN has assessed essentially every species of (birds through BirdLife, mammals,
 *  amphibians, reptiles, sharks and rays, reef-building corals). A miss there is more likely a
 *  naming gap than a species IUCN never looked at, so it isn't recorded as Not Evaluated. */
export const COMPREHENSIVELY_ASSESSED_TAXON_CLASSES = new Set([
  "aves",
  "mammalia",
  "aquatic_mammalia",
  "amphibia",
  "squamata",
  "testudines",
  "elasmobranchii",
  "corals",
]);

export function classCompatible(taxonClass: string, iucnClass: string): boolean {
  const allowed = IUCN_CLASSES_BY_TAXON_CLASS[taxonClass];
  return !allowed || allowed.includes(iucnClass);
}

const normName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

// Latin endings that change with the genus' gender or a patronym's spelling. Longest first.
const ENDINGS = ["ensis", "ense", "iae", "ii", "ae", "us", "um", "is", "er", "ra", "rum", "a", "e", "i", "os", "on"];

/** "Genus stem" for spelling matches; null when the epithet is too short to compare safely. */
export function spellingKey(name: string): string | null {
  const [genus, epithet, ...rest] = normName(name).split(" ");
  if (!genus || !epithet || rest.length > 0) return null;
  let stem = epithet;
  for (const end of ENDINGS) {
    if (epithet.endsWith(end) && epithet.length - end.length >= 3) {
      // niger/nigra/nigrum share "nigr".
      stem =
        end === "er"
          ? epithet.slice(0, -2) + "r"
          : end === "ra" || end === "rum"
            ? epithet.slice(0, -end.length) + "r"
            : epithet.slice(0, -end.length);
      break;
    }
  }
  return stem.length >= 3 ? `${genus} ${stem}` : null;
}

/** The epithet's spelling-insensitive stem, for telling a genus move from a split. */
function epithetKey(name: string): string | null {
  const key = spellingKey(name);
  return key ? key.split(" ")[1] : (normName(name).split(" ")[1] ?? null);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface IucnIndex {
  byTaxonId: Map<number, IucnAccepted>;
  byName: Map<string, IucnAccepted[]>;
  bySynonym: Map<string, IucnAccepted[]>;
  bySubspeciesName: Map<string, IucnAccepted[]>;
  bySpelling: Map<string, IucnAccepted[]>;
}

export function buildIucnIndex(list: Pick<IucnRedList, "accepted" | "synonyms">): IucnIndex {
  const byTaxonId = new Map(list.accepted.map((a) => [a.taxonId, a]));
  const byName = new Map<string, IucnAccepted[]>();
  const bySpelling = new Map<string, IucnAccepted[]>();
  for (const a of list.accepted) {
    pushTo(byName, normName(a.name), a);
    const key = spellingKey(a.name);
    if (key) pushTo(bySpelling, key, a);
  }
  const bySynonym = new Map<string, IucnAccepted[]>();
  const bySubspeciesName = new Map<string, IucnAccepted[]>();
  for (const s of list.synonyms) {
    const target = byTaxonId.get(s.acceptedTaxonId);
    if (!target) continue;
    if (s.infraEpithet) {
      // "Genus species ssp. epithet" stands for a taxon a catalog might call "Genus epithet".
      pushTo(bySubspeciesName, `${normName(s.name).split(" ")[0]} ${s.infraEpithet}`, target);
    } else if (normName(s.name) !== normName(target.name)) {
      pushTo(bySynonym, normName(s.name), target);
    }
  }
  return { byTaxonId, byName, bySynonym, bySubspeciesName, bySpelling };
}

/** Distinct class-compatible assessments for a lookup. */
function candidates(found: Iterable<IucnAccepted | undefined>, taxonClass: string): IucnAccepted[] {
  const byId = new Map<number, IucnAccepted>();
  for (const a of found) if (a && classCompatible(taxonClass, a.className)) byId.set(a.taxonId, a);
  return [...byId.values()];
}

export function matchIucn(species: IucnCatalogSpecies[], index: IucnIndex): Map<string, IucnMatch> {
  const result = new Map<string, IucnMatch>();
  const byId = new Map(species.map((s) => [s.id, s]));
  // Assessment -> the catalog species that has its exact name.
  const directOwner = new Map<number, string>();

  // 1. Exact accepted names.
  for (const s of species) {
    const found = candidates(index.byName.get(normName(s.scientificName)) ?? [], s.taxonClass);
    if (found.length === 1) {
      const a = found[0];
      result.set(s.id, { kind: "assessed", method: "name", taxonId: a.taxonId, code: a.code, iucnName: a.name });
      directOwner.set(a.taxonId, s.id);
    } else if (found.length > 1) {
      result.set(s.id, { kind: "none", ambiguous: true });
    }
  }

  // 2. Indirect routes, first one that finds anything.
  const indirect = new Map<string, { method: IucnMatchMethod; target: IucnAccepted }>();
  for (const s of species) {
    if (result.has(s.id)) continue;
    const routes: Array<[IucnMatchMethod, () => IucnAccepted[]]> = [
      ["synonym", () => candidates(index.bySynonym.get(normName(s.scientificName)) ?? [], s.taxonClass)],
      [
        "catalog_synonym",
        () =>
          candidates(
            (s.synonyms ?? []).flatMap((n) => [
              ...(index.byName.get(normName(n)) ?? []),
              ...(index.bySynonym.get(normName(n)) ?? []),
            ]),
            s.taxonClass,
          ),
      ],
      [
        "gbif_key",
        () =>
          candidates([s.gbifIucnTaxonId != null ? index.byTaxonId.get(s.gbifIucnTaxonId) : undefined], s.taxonClass),
      ],
      [
        "spelling",
        () => {
          const key = spellingKey(s.scientificName);
          return key ? candidates(index.bySpelling.get(key) ?? [], s.taxonClass) : [];
        },
      ],
    ];
    for (const [method, find] of routes) {
      const found = find();
      if (found.length === 0) continue;
      if (found.length > 1) result.set(s.id, { kind: "none", ambiguous: true });
      else indirect.set(s.id, { method, target: found[0] });
      break;
    }
  }

  // An assessment reached indirectly by several catalog species, or owned by one directly, is a
  // species the catalog splits: none of them takes its status. Unless the epithet is the same
  // (Sylvia curruca and Curruca curruca): that's the same species moved to another genus, so the
  // catalog has it twice, and both copies take the status.
  const indirectCount = new Map<number, number>();
  for (const { target } of indirect.values())
    indirectCount.set(target.taxonId, (indirectCount.get(target.taxonId) ?? 0) + 1);
  for (const [id, { method, target }] of indirect) {
    const shared = directOwner.has(target.taxonId) || (indirectCount.get(target.taxonId) ?? 0) > 1;
    // A near-spelling of a name another catalog species has exactly is more likely a different
    // species than a split, so it's no match at all.
    if (shared && method === "spelling") continue;
    const s = byId.get(id)!;
    const sameTaxon = epithetKey(s.scientificName) === epithetKey(target.name);
    if (shared && !sameTaxon) {
      result.set(id, {
        kind: "part_of",
        via: "lumped",
        taxonId: target.taxonId,
        parentName: target.name,
        parentCode: target.code,
      });
      continue;
    }
    const owner = directOwner.get(target.taxonId);
    result.set(id, {
      kind: "assessed",
      method,
      taxonId: target.taxonId,
      code: target.code,
      iucnName: target.name,
      ...(owner ? { duplicateOf: owner } : {}),
    });
  }

  // 3. Not assessed on its own, but IUCN covers it as a subspecies, or it was split from an
  //    assessed species.
  for (const s of species) {
    if (result.has(s.id)) continue;
    const asSubspecies = candidates(index.bySubspeciesName.get(normName(s.scientificName)) ?? [], s.taxonClass);
    if (asSubspecies.length === 1) {
      const p = asSubspecies[0];
      result.set(s.id, {
        kind: "part_of",
        via: "subspecies",
        taxonId: p.taxonId,
        parentName: p.name,
        parentCode: p.code,
      });
      continue;
    }
    if (s.splitFromName) {
      const parent = candidates(
        [
          ...(index.byName.get(normName(s.splitFromName)) ?? []),
          ...(index.bySynonym.get(normName(s.splitFromName)) ?? []),
        ],
        s.taxonClass,
      );
      if (parent.length === 1) {
        const p = parent[0];
        result.set(s.id, { kind: "part_of", via: "split", taxonId: p.taxonId, parentName: p.name, parentCode: p.code });
        continue;
      }
    }
    result.set(s.id, { kind: "none", ambiguous: false });
  }
  return result;
}

export interface IucnCurrent {
  status: IucnCode | null;
  source: IucnSource | null;
}

export interface IucnDecision {
  status: IucnCode | null;
  source: IucnSource | null;
  note: string | null;
  taxonId: number | null;
}

/** What to store for a species, given its match and what it has now. Always the full set of
 *  IUCN columns; the caller stamps iucn_checked_at. `gbifNotEvaluated`: GBIF's key-based link to
 *  the Red List found nothing either, which settles a miss even in a comprehensively assessed
 *  group (two independent matches failing, for an accepted name, is a species IUCN hasn't
 *  assessed: most are described after their group's last full assessment). */
export function decideIucn(
  match: IucnMatch,
  taxonClass: string,
  current: IucnCurrent,
  gbifNotEvaluated = false,
): IucnDecision {
  if (match.kind === "assessed") {
    return { status: match.code, source: "iucn_red_list", note: null, taxonId: match.taxonId };
  }
  if (match.kind === "part_of") {
    const rated = `rated ${IUCN_NAMES[match.parentCode]}`;
    const note =
      match.via === "subspecies"
        ? `Not assessed on its own: IUCN treats it as a subspecies of ${match.parentName}, ${rated}.`
        : match.via === "split"
          ? `Not assessed on its own: split from ${match.parentName}, which IUCN has ${rated}.`
          : `Not assessed on its own: IUCN includes it in ${match.parentName}, ${rated}.`;
    return { status: "NE", source: "iucn_red_list", note, taxonId: match.taxonId };
  }
  // No match. A status from another source (Wikidata follows its own synonym links) or from an
  // earlier Red List version is kept rather than replaced by a guess.
  if (current.status && current.status !== "NE") {
    return { status: current.status, source: current.source, note: null, taxonId: null };
  }
  if (match.ambiguous) {
    return {
      status: null,
      source: null,
      note: "Several IUCN-assessed species share this name, so none was assigned.",
      taxonId: null,
    };
  }
  if (COMPREHENSIVELY_ASSESSED_TAXON_CLASSES.has(taxonClass) && !gbifNotEvaluated) {
    return {
      status: null,
      source: null,
      note: "No IUCN assessment found under this name or its synonyms.",
      taxonId: null,
    };
  }
  if (COMPREHENSIVELY_ASSESSED_TAXON_CLASSES.has(taxonClass)) {
    return {
      status: "NE",
      source: "iucn_red_list",
      note: "No IUCN assessment under this name: usually a recently described species, or one IUCN still includes in another.",
      taxonId: null,
    };
  }
  return { status: "NE", source: "iucn_red_list", note: null, taxonId: null };
}
