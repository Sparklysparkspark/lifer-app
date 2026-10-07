// Adds species the catalog is missing: every iNaturalist research-grade species on any cached
// region list (data/inat-species-counts-cache) that matches no catalog species, name or synonym,
// and falls inside one of Lifer's groups, plus every current eBird species the catalog lacks.
// Checklists can only pick from catalog species, so without this a species the catalog never
// had (e.g. a recent split) drops off every checklist.
//
// Offline where it can be: iNaturalist taxon details (rank, classification, common name,
// observation count) are cached in data/inat-taxa-cache.json and only fetched for taxa not seen
// before. Groups use the same clades as the catalog builders (build-seed-*.ts), found by
// iNaturalist ancestry, so what's added matches what the builders would have included. Skipped:
// hybrids, inactive or extinct taxa, domestic animals, and invertebrates with neither a common
// name nor 10 observations (the builders' own visibility floor).
//
// New species get gbif_key = -inat_taxon_id (real GBIF keys are positive; Other Taxa use the
// same convention) and their eBird code by scientific name. Photos and descriptions come from the
// enrichment stage afterwards.
//
// Usage: npx tsx src/scripts/add-missing-species.ts [--apply] [--offline]
// Writes data/build/added-species-<date>.tsv listing what was added (or would be).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { toTitleCase } from "../fetch/fetch-gbif-vernacular.js";
import { inatGet } from "../inatApi.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const PLACE_CACHE_DIR = path.join(DATA_DIR, "inat-species-counts-cache");
const TAXA_CACHE_PATH = path.join(DATA_DIR, "inat-taxa-cache.json");
const EBIRD_TAXONOMY_CSV = path.join(DATA_DIR, "reference", "ebird-taxonomy.csv");
const BUILD_DIR = path.join(DATA_DIR, "build");

// Checked in order: the first clade a taxon falls in decides its group, so marine mammals go to
// Fish (the app files them there, build-seed-mammals.ts) before Mammals.
export const GROUP_CLADES: Array<[string, string[]]> = [
  ["actinopterygii", ["Cetacea", "Sirenia", "Phocidae", "Otariidae", "Odobenidae"]],
  ["aves", ["Aves"]],
  ["mammalia", ["Mammalia"]],
  [
    "actinopterygii",
    [
      "Actinopterygii",
      "Elasmobranchii",
      "Holocephali",
      "Myxini",
      "Petromyzontiformes",
      "Coelacanthiformes",
      "Ceratodontiformes",
      "Lepidosireniformes",
    ],
  ],
  ["squamata", ["Squamata", "Crocodylia", "Rhynchocephalia"]],
  ["testudines", ["Testudines"]],
  ["amphibia", ["Amphibia"]],
  ["corals", ["Scleractinia"]],
  ["jellies_and_anemones", ["Actiniaria", "Scyphozoa", "Cubozoa", "Hydrozoa"]],
  ["echinodermata", ["Asteroidea", "Echinoidea"]],
  ["nudibranchs", ["Nudibranchia"]],
  [
    "marine_mollusks",
    [
      "Neogastropoda",
      "Littorinimorpha",
      "Trochida",
      "Cypraeidae",
      "Conidae",
      "Muricidae",
      "Volutidae",
      "Strombidae",
      "Cassidae",
      "Tonnidae",
      "Terebridae",
      "Trochidae",
      "Turbinidae",
      "Harpidae",
      "Olividae",
      "Mitridae",
      "Cancellariidae",
      "Tridacnidae",
    ],
  ],
  ["cephalopoda", ["Cephalopoda"]],
  ["crustacea", ["Decapoda"]],
  ["sponges_tunicates_other", ["Porifera", "Ascidiacea"]],
];
const VERTEBRATE_GROUPS = new Set(["aves", "mammalia", "actinopterygii", "squamata", "testudines", "amphibia"]);
// Domestic animals and feral forms iNaturalist lists as their own species.
const DOMESTIC = new Set([
  "Canis familiaris",
  "Felis catus",
  "Bos taurus",
  "Capra hircus",
  "Ovis aries",
  "Equus caballus",
  "Equus asinus",
  "Sus domesticus",
  "Cavia porcellus",
  "Oryctolagus domesticus",
  "Camelus dromedarius domesticus",
  "Bubalus bubalis",
]);

interface TaxonDetail {
  rank: string;
  active: boolean;
  ancestors: number[];
  common: string | null;
  name: string;
  extinct: boolean;
  obs: number;
}
type TaxaCache = Record<string, TaxonDetail | null> & {
  __clades__?: Record<string, number | null>;
  __ancestors__?: Record<string, { rank: string; name: string }>;
};

function loadTaxaCache(): TaxaCache {
  return existsSync(TAXA_CACHE_PATH) ? (JSON.parse(readFileSync(TAXA_CACHE_PATH, "utf8")) as TaxaCache) : {};
}
function saveTaxaCache(cache: TaxaCache) {
  writeFileSync(TAXA_CACHE_PATH, JSON.stringify(cache));
}

async function resolveCladeIds(cache: TaxaCache, offline: boolean): Promise<Array<[number, string]>> {
  const clades = (cache.__clades__ ??= {});
  const out: Array<[number, string]> = [];
  for (const [group, names] of GROUP_CLADES) {
    for (const n of names) {
      if (!(n in clades)) {
        if (offline) continue;
        const d = await inatGet<{ results: Array<{ id: number; name: string; rank: string }> }>(
          `https://api.inaturalist.org/v1/taxa?${new URLSearchParams({ q: n, is_active: "true", per_page: "30" })}`,
        );
        clades[n] = d.results.find((t) => t.name === n && t.rank !== "species")?.id ?? null;
      }
      const id = clades[n];
      if (id) out.push([id, group]);
    }
  }
  return out;
}

async function fetchDetails(ids: string[], cache: TaxaCache) {
  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30);
    const d = await inatGet<{
      results: Array<{
        id: number;
        rank: string;
        is_active: boolean;
        ancestor_ids?: number[];
        preferred_common_name?: string;
        name: string;
        extinct?: boolean;
        observations_count?: number;
      }>;
    }>(`https://api.inaturalist.org/v1/taxa/${batch.join(",")}`);
    const got = new Map(d.results.map((t) => [String(t.id), t]));
    for (const id of batch) {
      const t = got.get(id);
      cache[id] = t
        ? {
            rank: t.rank,
            active: t.is_active,
            ancestors: t.ancestor_ids ?? [],
            common: t.preferred_common_name ?? null,
            name: t.name,
            extinct: !!t.extinct,
            obs: t.observations_count ?? 0,
          }
        : null;
    }
    if ((i / 30) % 20 === 0) saveTaxaCache(cache);
  }
  saveTaxaCache(cache);
}

/** Names of family and order ancestors, fetched once for the ancestor ids the additions use. */
async function ancestorNames(ids: number[], cache: TaxaCache, offline: boolean) {
  const known = (cache.__ancestors__ ??= {});
  const todo = [...new Set(ids)].filter((id) => !(String(id) in known));
  if (!offline) {
    for (let i = 0; i < todo.length; i += 30) {
      const batch = todo.slice(i, i + 30);
      const d = await inatGet<{ results: Array<{ id: number; rank: string; name: string }> }>(
        `https://api.inaturalist.org/v1/taxa/${batch.join(",")}`,
      );
      for (const t of d.results) known[String(t.id)] = { rank: t.rank, name: t.name };
    }
    saveTaxaCache(cache);
  }
  return known;
}

export interface EbirdRow {
  sci: string;
  common: string;
  code: string;
  category: string;
  family: string;
  order: string;
  extinct: boolean;
  reportAs: string;
}
function loadEbird(): EbirdRow[] {
  const lines = readFileSync(EBIRD_TAXONOMY_CSV, "utf8").split("\n");
  const header = parseCsvLine(lines[0]);
  const at = (n: string) => header.indexOf(n);
  const rows: EbirdRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    rows.push({
      sci: f[at("SCIENTIFIC_NAME")],
      common: f[at("COMMON_NAME")],
      code: f[at("SPECIES_CODE")],
      category: f[at("CATEGORY")],
      family: f[at("FAMILY_SCI_NAME")],
      order: f[at("ORDER")],
      extinct: f[at("EXTINCT")] === "true" || f[at("EXTINCT")] === "1",
      reportAs: f[at("REPORT_AS")] ?? "",
    });
  }
  return rows;
}
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** eBird subspecies groups as the species name other lists give them ("Setophaga auduboni" for
 *  Yellow-rumped Warbler (Audubon's)), each with the eBird species it's reported as. Groups
 *  spanning several subspecies ("[auduboni Group]", "a/b") have no such name. */
export function ebirdFormsByBinomial(ebird: EbirdRow[]): Map<string, string> {
  const speciesCodes = new Set(ebird.filter((r) => r.category === "species").map((r) => r.code));
  const forms = new Map<string, string>();
  for (const r of ebird) {
    if ((r.category !== "issf" && r.category !== "form") || !speciesCodes.has(r.reportAs)) continue;
    const parts = r.sci.split(" ");
    if (parts.length !== 3 || /[[/]/.test(r.sci)) continue;
    forms.set(`${parts[0]} ${parts[2]}`, r.reportAs);
  }
  return forms;
}

export interface FormDuplicate {
  oldId: string;
  oldName: string;
  newId: string;
  newName: string;
}

/** Catalog birds eBird treats as a subspecies group of another catalog species (Audubon's
 *  Warbler, a form of Yellow-rumped Warbler): the same species twice, for review into
 *  species-merges.tsv. */
export async function findEbirdFormDuplicates(): Promise<FormDuplicate[]> {
  const ebird = loadEbird();
  const ebirdSpecies = new Set(ebird.filter((r) => r.category === "species").map((r) => r.sci));
  const forms = ebirdFormsByBinomial(ebird);
  const birds = await pool.query<{ id: string; name: string; ebird_code: string | null }>(
    `SELECT id, scientific_name AS name, ebird_code FROM species WHERE taxon_class = 'aves' AND NOT is_other_taxa`,
  );
  const byCode = new Map(birds.rows.filter((b) => b.ebird_code).map((b) => [b.ebird_code!, b]));
  const out: FormDuplicate[] = [];
  for (const b of birds.rows) {
    if (ebirdSpecies.has(b.name)) continue;
    const parentCode = forms.get(b.name);
    const parent = parentCode ? byCode.get(parentCode) : undefined;
    if (parent && parent.id !== b.id)
      out.push({ oldId: b.id, oldName: b.name, newId: parent.id, newName: parent.name });
  }
  return out;
}

export interface NewSpecies {
  scientificName: string;
  commonName: string | null;
  taxonClass: string;
  inatTaxonId: number | null;
  ebirdCode: string | null;
  family: string | null;
  order: string | null;
  gbifKey: number;
  source: "inat" | "ebird";
  places: number;
  inatObservations: number;
}

/** A stable negative key for an eBird-only species with no iNaturalist id (FNV-1a of the code,
 *  offset below every -inat_taxon_id). */
function syntheticKeyForEbird(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -(10_000_000_000 + h);
}

/** An iNaturalist species that is really a catalog entry under another spelling or genus:
 *  linked instead of added (the entry gets the iNaturalist id, the name becomes a synonym). */
export interface SpeciesLink {
  speciesId: string;
  catalogName: string;
  inatTaxonId: number;
  name: string;
  rule: "ending" | "genus_move" | "inat_lookup";
}

// Latin endings that change with a genus' gender (dorsatus/dorsatum, jacobitus/jacobita).
const epithetStem = (e: string) => e.replace(/(us|um|a|is|e|i|ae)$/, "");

export async function findMissingSpecies(opts: {
  offline: boolean;
}): Promise<{ add: NewSpecies[]; synonyms: Array<{ name: string; speciesId: string }>; links: SpeciesLink[] }> {
  const catalog = await pool.query<{
    name: string;
    id: string;
    inat_taxon_id: number | null;
    ebird_code: string | null;
    taxon_class: string | null;
    family: string | null;
    is_synonym: boolean;
  }>(
    `SELECT scientific_name AS name, id, inat_taxon_id, ebird_code, taxon_class, family, false AS is_synonym FROM species WHERE NOT is_other_taxa
     UNION ALL SELECT ss.synonym_name, s.id, NULL, NULL, s.taxon_class, s.family, true FROM species_synonyms ss JOIN species s ON s.id = ss.species_id`,
  );
  const knownNames = new Map(catalog.rows.map((r) => [r.name, r.id]));
  const knownInat = new Set(catalog.rows.filter((r) => r.inat_taxon_id != null).map((r) => r.inat_taxon_id!));
  const knownEbird = new Set(catalog.rows.filter((r) => r.ebird_code).map((r) => r.ebird_code!));

  // Unmatched research-grade taxa across every cached place list, with how many places list them.
  const places = new Map<string, { name: string; count: number }>();
  for (const f of existsSync(PLACE_CACHE_DIR) ? readdirSync(PLACE_CACHE_DIR) : []) {
    if (!f.endsWith(".json")) continue;
    let d: { taxa?: Array<{ id: number; name: string }> };
    try {
      d = JSON.parse(readFileSync(path.join(PLACE_CACHE_DIR, f), "utf8"));
    } catch {
      continue;
    }
    for (const t of d.taxa ?? []) {
      if (knownInat.has(t.id) || knownNames.has(t.name)) continue;
      const e = places.get(String(t.id)) ?? { name: t.name, count: 0 };
      e.count++;
      places.set(String(t.id), e);
    }
  }

  const cache = loadTaxaCache();
  const missingDetails = [...places.keys()].filter((id) => !(id in cache));
  if (missingDetails.length > 0) {
    if (opts.offline)
      console.log(
        `[add-missing-species] ${missingDetails.length} taxa have no cached details (offline, left for a later run)`,
      );
    else await fetchDetails(missingDetails, cache);
  }
  const clades = await resolveCladeIds(cache, opts.offline);

  const ebird = loadEbird();
  const ebirdBySci = new Map(ebird.filter((r) => r.category === "species").map((r) => [r.sci, r]));
  const ebirdForms = ebirdFormsByBinomial(ebird);
  const speciesByEbird = new Map(catalog.rows.filter((r) => r.ebird_code).map((r) => [r.ebird_code!, r.id]));

  const candidates: Array<{ id: string; detail: TaxonDetail; group: string; places: number }> = [];
  for (const [id, p] of places) {
    const t = cache[id];
    if (!t || t.rank !== "species" || !t.active || t.extinct || t.name.includes("×") || DOMESTIC.has(t.name)) continue;
    const anc = new Set(t.ancestors);
    const group = clades.find(([cid]) => anc.has(cid))?.[1];
    if (!group) continue;
    if (!VERTEBRATE_GROUPS.has(group) && !t.common && t.obs < 10) continue;
    candidates.push({ id, detail: t, group, places: p.count });
  }

  const ancestors = await ancestorNames(
    candidates.flatMap((c) => c.detail.ancestors),
    cache,
    opts.offline,
  );

  // Catalog entries with no iNaturalist id yet are the only ones a new name can be a respelling
  // of: an entry with its own id is a different iNaturalist taxon by definition.
  const currentTaxonCachePath = path.join(DATA_DIR, "inat-current-taxon-cache.json");
  const currentTaxon: Record<string, number | null> = existsSync(currentTaxonCachePath)
    ? JSON.parse(readFileSync(currentTaxonCachePath, "utf8"))
    : {};
  const unlinked = catalog.rows.filter((r) => !r.is_synonym && r.inat_taxon_id == null);
  const byGenusStem = new Map<string, (typeof unlinked)[number]>();
  const byStemFamily = new Map<string, (typeof unlinked)[number]>();
  const byInatLookup = new Map<number, (typeof unlinked)[number]>();
  for (const r of unlinked) {
    const [genus, epithet] = r.name.split(" ");
    if (!epithet) continue;
    byGenusStem.set(`${r.taxon_class}|${genus}|${epithetStem(epithet)}`, r);
    if (r.family) byStemFamily.set(`${r.taxon_class}|${r.family}|${epithetStem(epithet)}`, r);
    const looked = currentTaxon[r.name];
    if (looked != null) byInatLookup.set(looked, r);
  }
  const links: SpeciesLink[] = [];
  const linkedSpecies = new Set<string>();
  let deferred = 0;

  const add: NewSpecies[] = [];
  const addedNames = new Set<string>();
  const synonyms: Array<{ name: string; speciesId: string }> = [];
  for (const c of candidates) {
    // Birds follow eBird: a species iNaturalist recognises that eBird counts as a form of a catalog
    // species is another name for that species, not a new one.
    if (c.group === "aves" && !ebirdBySci.has(c.detail.name)) {
      const parentCode = ebirdForms.get(c.detail.name);
      const parent = parentCode ? speciesByEbird.get(parentCode) : undefined;
      if (parent) {
        synonyms.push({ name: c.detail.name, speciesId: parent });
        continue;
      }
    }
    const rankName = (rank: string) =>
      c.detail.ancestors.map((a) => ancestors[String(a)]).find((a) => a?.rank === rank)?.name ?? null;
    const [genus, epithet] = c.detail.name.split(" ");
    const family = rankName("family");
    const stem = epithet ? epithetStem(epithet) : "";
    const match =
      (byInatLookup.get(Number(c.id)) && { r: byInatLookup.get(Number(c.id))!, rule: "inat_lookup" as const }) ||
      (byGenusStem.get(`${c.group}|${genus}|${stem}`) && {
        r: byGenusStem.get(`${c.group}|${genus}|${stem}`)!,
        rule: "ending" as const,
      }) ||
      (family &&
        byStemFamily.get(`${c.group}|${family}|${stem}`) && {
          r: byStemFamily.get(`${c.group}|${family}|${stem}`)!,
          rule: "genus_move" as const,
        }) ||
      null;
    if (match && !linkedSpecies.has(match.r.id)) {
      // A shared epithet and family can also match two different species, so a genus move is only
      // linked once iNaturalist confirms the catalog's name is now this taxon. Offline, it waits.
      let confirmed = true;
      if (match.rule === "genus_move") {
        const resolved = await currentInatTaxonId(match.r.name, currentTaxon, opts.offline);
        if (resolved === undefined) {
          deferred++;
          continue;
        }
        confirmed = resolved === Number(c.id);
      }
      if (confirmed) {
        links.push({
          speciesId: match.r.id,
          catalogName: match.r.name,
          inatTaxonId: Number(c.id),
          name: c.detail.name,
          rule: match.rule,
        });
        linkedSpecies.add(match.r.id);
        continue;
      }
    }
    const eb = c.group === "aves" ? ebirdBySci.get(c.detail.name) : undefined;
    const common = eb?.common ? toTitleCase(eb.common) : c.detail.common ? toTitleCase(c.detail.common) : null;
    add.push({
      scientificName: c.detail.name,
      commonName: common,
      taxonClass: c.group,
      inatTaxonId: Number(c.id),
      ebirdCode: eb && !knownEbird.has(eb.code) ? eb.code : null,
      family: rankName("family"),
      order: rankName("order"),
      gbifKey: -Number(c.id),
      source: "inat",
      places: c.places,
      inatObservations: c.detail.obs,
    });
    addedNames.add(c.detail.name);
  }

  // Current eBird species the catalog still lacks and iNaturalist didn't bring in. When
  // iNaturalist knows the name under an id the catalog already has, it's the same species under
  // eBird's name: a synonym, not a new entry.
  const speciesByInat = new Map(
    catalog.rows.filter((r) => r.inat_taxon_id != null).map((r) => [r.inat_taxon_id!, r.id]),
  );
  for (const r of ebirdBySci.values()) {
    if (r.extinct || knownEbird.has(r.code) || knownNames.has(r.sci) || addedNames.has(r.sci)) continue;
    const inatId = currentTaxon[r.sci];
    const existing = inatId != null ? speciesByInat.get(inatId) : undefined;
    if (existing) {
      synonyms.push({ name: r.sci, speciesId: existing });
      continue;
    }
    add.push({
      scientificName: r.sci,
      commonName: toTitleCase(r.common),
      taxonClass: "aves",
      inatTaxonId: null,
      ebirdCode: r.code,
      family: r.family || null,
      order: r.order || null,
      gbifKey: syntheticKeyForEbird(r.code),
      source: "ebird",
      places: 0,
      inatObservations: 0,
    });
  }
  saveCurrentTaxonCache(currentTaxonCachePath, currentTaxon);
  if (deferred > 0)
    console.log(`[add-missing-species] ${deferred} possible genus moves left for an online run to confirm`);
  return { add, synonyms, links };
}

let currentTaxonDirty = false;
/** iNaturalist's current active taxon for a (possibly outdated) name, via its own synonym
 *  tracking; cached in the same file inatChecklist.ts uses. undefined = unknown (offline). */
async function currentInatTaxonId(
  name: string,
  cache: Record<string, number | null>,
  offline: boolean,
): Promise<number | null | undefined> {
  if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
  if (offline) return undefined;
  const d = await inatGet<{ results: Array<{ id: number; is_active: boolean; matched_term: string | null }> }>(
    `https://api.inaturalist.org/v1/taxa?${new URLSearchParams({ q: name, per_page: "10", is_active: "any", rank: "species" })}`,
  );
  const hit =
    d.results.filter((r) => r.matched_term?.toLowerCase() === name.toLowerCase()).find((r) => r.is_active)?.id ?? null;
  cache[name] = hit;
  currentTaxonDirty = true;
  return hit;
}
function saveCurrentTaxonCache(file: string, cache: Record<string, number | null>) {
  if (!currentTaxonDirty) return;
  // Merged with what's on disk, since a checklist build may have written to it meanwhile.
  const onDisk: Record<string, number | null> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...onDisk, ...cache }));
}

export async function insertMissingSpecies(
  add: NewSpecies[],
  synonyms: Array<{ name: string; speciesId: string }>,
  links: SpeciesLink[] = [],
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Respellings and genus moves: the existing entry takes the iNaturalist id and the new name.
    await client.query(
      `UPDATE species s SET inat_taxon_id = v.inat FROM unnest($1::uuid[], $2::int[]) AS v(id, inat)
       WHERE s.id = v.id AND s.inat_taxon_id IS NULL`,
      [links.map((l) => l.speciesId), links.map((l) => l.inatTaxonId)],
    );
    await client.query(
      `INSERT INTO species_synonyms (species_id, synonym_name, source) SELECT id, name, 'inat' FROM unnest($1::uuid[], $2::text[]) AS v(id, name)
       ON CONFLICT (synonym_name) DO NOTHING`,
      [links.map((l) => l.speciesId), links.map((l) => l.name)],
    );
    const res = await client.query(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, inat_taxon_id, ebird_code, family, taxon_order)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[])
       ON CONFLICT (gbif_key) DO NOTHING
       RETURNING id, inat_taxon_id`,
      [
        add.map((a) => a.gbifKey),
        add.map((a) => a.scientificName),
        add.map((a) => a.commonName),
        add.map((a) => a.taxonClass),
        add.map((a) => a.inatTaxonId),
        add.map((a) => a.ebirdCode),
        add.map((a) => a.family),
        add.map((a) => a.order),
      ],
    );
    await client.query(
      `INSERT INTO species_traits (species_id, source_attribution) SELECT * FROM unnest($1::uuid[], $2::text[]) ON CONFLICT DO NOTHING`,
      [
        res.rows.map((r) => r.id),
        res.rows.map((r) => (r.inat_taxon_id != null ? "iNaturalist taxonomy" : "eBird taxonomy")),
      ],
    );
    await client.query(
      `INSERT INTO species_synonyms (species_id, synonym_name, source) SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])
       ON CONFLICT (synonym_name) DO NOTHING`,
      [synonyms.map((s) => s.speciesId), synonyms.map((s) => s.name), synonyms.map(() => "ebird")],
    );
    // Taxa recorded as unmatched on region lists now have a species.
    await client.query(
      `UPDATE region_unmatched_taxa u SET resolved_species_id = s.id FROM species s
       WHERE u.resolved_species_id IS NULL AND ((u.source = 'inat' AND s.inat_taxon_id::text = u.external_id) OR s.scientific_name = u.name)`,
    );
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const offline = args.includes("--offline") || process.env.LIFER_INAT_OFFLINE === "1";
  const { add, synonyms, links } = await findMissingSpecies({ offline });
  const byRule = new Map<string, number>();
  for (const l of links) byRule.set(l.rule, (byRule.get(l.rule) ?? 0) + 1);
  console.log(
    `[add-missing-species] ${links.length} are existing entries under another spelling or genus (${[...byRule].map(([r, n]) => `${r} ${n}`).join(", ")}), linked instead of added`,
  );
  const byGroup = new Map<string, number>();
  for (const a of add) byGroup.set(a.taxonClass, (byGroup.get(a.taxonClass) ?? 0) + 1);
  console.log(`[add-missing-species] ${add.length} species to add, ${synonyms.length} eBird names to link as synonyms`);
  for (const [g, n] of [...byGroup].sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(24)} ${n}`);
  mkdirSync(BUILD_DIR, { recursive: true });
  const report = path.join(BUILD_DIR, `added-species-${new Date().toISOString().slice(0, 10)}.tsv`);
  writeFileSync(
    report,
    [
      "scientific_name\tcommon_name\tgroup\tinat_taxon_id\tebird_code\tfamily\tsource\tplaces\tinat_observations",
      ...add
        .sort((a, b) => b.inatObservations - a.inatObservations)
        .map((a) =>
          [
            a.scientificName,
            a.commonName ?? "",
            a.taxonClass,
            a.inatTaxonId ?? "",
            a.ebirdCode ?? "",
            a.family ?? "",
            a.source,
            a.places,
            a.inatObservations,
          ].join("\t"),
        ),
    ].join("\n"),
  );
  writeFileSync(
    report.replace(".tsv", "-linked.tsv"),
    [
      "catalog_name\tinat_name\tinat_taxon_id\trule",
      ...links.map((l) => [l.catalogName, l.name, l.inatTaxonId, l.rule].join("\t")),
    ].join("\n"),
  );
  console.log(`[add-missing-species] lists written to ${report} and its -linked.tsv`);
  if (apply) {
    const n = await insertMissingSpecies(add, synonyms, links);
    console.log(`[add-missing-species] added ${n} species`);
  } else {
    console.log("[add-missing-species] preview only (pass --apply)");
  }
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
