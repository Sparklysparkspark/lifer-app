// IUCN Red List status for every catalog species: matches the catalog against the Red List
// archive (iucnRedList.ts, iucnMatch.ts) and writes species_traits.iucn_status and its companion
// columns (migration 129). Other Taxa species keep the status iNaturalist gave them when added.
import type { Pool, PoolClient } from "pg";
import { isIucnCode, type IucnCode, type IucnSource } from "@lifer/shared";
import { fetchWithRetry } from "@lifer/core/lib/fetchWithRetry.js";
import type { IucnRedList } from "./iucnRedList.js";
import {
  buildIucnIndex,
  COMPREHENSIVELY_ASSESSED_TAXON_CLASSES,
  decideIucn,
  matchIucn,
  type IucnCatalogSpecies,
  type IucnDecision,
  type IucnMatch,
} from "./iucnMatch.js";

type Db = Pool | PoolClient;

export interface IucnCatalogRow extends IucnCatalogSpecies {
  gbifKey: number | null;
  listed: boolean;
  current: { status: IucnCode | null; source: IucnSource | null; note: string | null; taxonId: number | null };
}

export async function loadIucnCatalog(db: Db, onlySpeciesIds?: string[]): Promise<IucnCatalogRow[]> {
  const res = await db.query<{
    id: string;
    gbif_key: string | null;
    scientific_name: string;
    taxon_class: string;
    iucn_status: string | null;
    iucn_source: IucnSource | null;
    iucn_note: string | null;
    iucn_taxon_id: string | null;
    synonyms: string[] | null;
    split_from: string | null;
    listed: boolean;
  }>(
    `SELECT s.id, s.gbif_key, s.scientific_name, s.taxon_class,
            t.iucn_status, t.iucn_source, t.iucn_note, t.iucn_taxon_id,
            (SELECT array_agg(y.synonym_name) FROM species_synonyms y WHERE y.species_id = s.id) AS synonyms,
            (SELECT p.scientific_name FROM species_splits sp JOIN species p ON p.id = sp.parent_species_id
              WHERE sp.daughter_species_id = s.id ORDER BY p.scientific_name LIMIT 1) AS split_from,
            EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id) AS listed
     FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
     WHERE s.is_other_taxa = false AND ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[]))`,
    [onlySpeciesIds ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    gbifKey: r.gbif_key == null ? null : Number(r.gbif_key),
    scientificName: r.scientific_name,
    taxonClass: r.taxon_class,
    synonyms: r.synonyms ?? [],
    splitFromName: r.split_from,
    listed: r.listed,
    current: {
      status: isIucnCode(r.iucn_status) ? r.iucn_status : null,
      source: r.iucn_source,
      note: r.iucn_note,
      taxonId: r.iucn_taxon_id == null ? null : Number(r.iucn_taxon_id),
    },
  }));
}

export interface GbifIucnLink {
  /** The IUCN taxon id GBIF links the key to. */
  taxonId: number | null;
  /** GBIF answered Not Evaluated for an accepted backbone name: its own key-based match to the
   *  Red List found nothing either. */
  notEvaluated: boolean;
}

/** GBIF's own link from a backbone key to an IUCN assessment. Cached in gbif_response_cache, so
 *  a rerun makes no calls. */
export async function gbifIucnLink(gbifKey: number): Promise<GbifIucnLink> {
  const res = await fetchWithRetry(`https://api.gbif.org/v1/species/${gbifKey}/iucnRedListCategory`, {
    headers: { "User-Agent": "lifer-data-pipeline/0.1 (IUCN status backfill)" },
  });
  const text = res.ok ? await res.text() : "";
  return parseGbifIucnLink(text);
}

export function parseGbifIucnLink(text: string): GbifIucnLink {
  if (!text) return { taxonId: null, notEvaluated: false }; // 204: GBIF has nothing to say
  const body = JSON.parse(text) as { iucnTaxonID?: string; code?: string; taxonomicStatus?: string };
  const id = Number(body.iucnTaxonID);
  if (Number.isFinite(id) && id > 0) return { taxonId: id, notEvaluated: false };
  return { taxonId: null, notEvaluated: body.code === "NE" && body.taxonomicStatus === "ACCEPTED" };
}

/** Who GBIF is asked about when the names didn't match: listed species in the comprehensively
 *  assessed groups (the default), every species in those groups, every species, or nobody. */
export type GbifFallbackScope = "listed" | "comprehensive" | "all" | "none";

export interface IucnBackfillOptions {
  apply: boolean;
  /** Which still-unmatched species to ask GBIF about, one call each. */
  gbifFallback?: GbifFallbackScope;
  /** Pause between GBIF calls that weren't cached. */
  gbifDelayMs?: number;
  lookupGbif?: (gbifKey: number) => Promise<GbifIucnLink>;
  log?: (message: string) => void;
  /** Only these species (tests, debugging). Split detection then only sees them, too. */
  onlySpeciesIds?: string[];
}

export interface IucnBackfillGroupStats {
  species: number;
  listed: number;
  /** Listed species with no status before this run. */
  listedMissingBefore: number;
  /** Listed species with a real category (anything but NE) after it. */
  listedAssessedAfter: number;
  /** Listed species with no status before that have a real category now. */
  listedNewlyAssessed: number;
  /** Listed species stored as Not Evaluated after it. */
  listedNotEvaluated: number;
  /** Listed species still without any status. */
  listedStillMissing: number;
}

export interface IucnBackfillResult {
  byMethod: Record<string, number>;
  byGroup: Record<string, IucnBackfillGroupStats>;
  changed: number;
  gbifLookups: number;
  /** Listed species that changed category (both before and after a real category). */
  categoryChanges: Array<{ name: string; from: IucnCode; to: IucnCode }>;
  /** Catalog species that look like one species entered twice (see IucnMatch.duplicateOf). */
  possibleDuplicates: Array<{ name: string; sameAs: string }>;
  decisions: Map<string, IucnDecision>;
  matches: Map<string, IucnMatch>;
}

function sameDecision(row: IucnCatalogRow, d: IucnDecision): boolean {
  return (
    row.current.status === d.status &&
    row.current.source === d.source &&
    row.current.note === d.note &&
    row.current.taxonId === d.taxonId
  );
}

export async function backfillIucnStatus(
  db: Pool,
  redList: IucnRedList,
  opts: IucnBackfillOptions,
): Promise<IucnBackfillResult> {
  const log = opts.log ?? (() => {});
  const catalog = await loadIucnCatalog(db, opts.onlySpeciesIds);
  const index = buildIucnIndex(redList);
  log(
    `${catalog.length} catalog species, ${redList.accepted.length} assessed animal species, ${redList.synonyms.length} synonyms`,
  );

  let matches = matchIucn(catalog, index);

  // The GBIF fallback: one cached call per species the names couldn't place.
  const scope = opts.gbifFallback ?? "listed";
  let gbifLookups = 0;
  if (scope !== "none") {
    const lookup = opts.lookupGbif ?? gbifIucnLink;
    const todo = catalog.filter(
      (s) =>
        s.gbifKey != null &&
        s.gbifKey > 0 &&
        matches.get(s.id)?.kind === "none" &&
        !(matches.get(s.id) as { ambiguous: boolean }).ambiguous &&
        (scope === "all" || COMPREHENSIVELY_ASSESSED_TAXON_CLASSES.has(s.taxonClass)) &&
        (scope !== "listed" || s.listed),
    );
    log(`asking GBIF about ${todo.length} species the names didn't match`);
    for (const s of todo) {
      const started = Date.now();
      const link = await lookup(s.gbifKey!);
      s.gbifIucnTaxonId = link.taxonId;
      s.gbifNotEvaluated = link.notEvaluated;
      gbifLookups++;
      if (gbifLookups % 250 === 0) log(`  GBIF ${gbifLookups}/${todo.length}`);
      // A cached answer comes back in a few ms; only live calls are paced.
      if (opts.gbifDelayMs && Date.now() - started > 50) await new Promise((r) => setTimeout(r, opts.gbifDelayMs));
    }
    if (todo.length > 0) matches = matchIucn(catalog, index);
  }

  const byMethod: Record<string, number> = {};
  const byGroup: Record<string, IucnBackfillGroupStats> = {};
  const decisions = new Map<string, IucnDecision>();
  const categoryChanges: IucnBackfillResult["categoryChanges"] = [];
  const possibleDuplicates: IucnBackfillResult["possibleDuplicates"] = [];
  const nameById = new Map(catalog.map((r) => [r.id, r.scientificName]));
  const updates: Array<{ row: IucnCatalogRow; decision: IucnDecision }> = [];
  for (const row of catalog) {
    const match = matches.get(row.id)!;
    const decision = decideIucn(match, row.taxonClass, row.current, row.gbifNotEvaluated === true);
    decisions.set(row.id, decision);
    if (match.kind === "assessed" && match.duplicateOf) {
      possibleDuplicates.push({ name: row.scientificName, sameAs: nameById.get(match.duplicateOf)! });
    }
    const label =
      match.kind === "assessed"
        ? match.method
        : match.kind === "part_of"
          ? `part_of:${match.via}`
          : match.ambiguous
            ? "ambiguous"
            : "none";
    byMethod[label] = (byMethod[label] ?? 0) + 1;

    const g = (byGroup[row.taxonClass] ??= {
      species: 0,
      listed: 0,
      listedMissingBefore: 0,
      listedAssessedAfter: 0,
      listedNewlyAssessed: 0,
      listedNotEvaluated: 0,
      listedStillMissing: 0,
    });
    g.species++;
    if (row.listed) {
      g.listed++;
      const before = row.current.status;
      const after = decision.status;
      if (!before) g.listedMissingBefore++;
      if (after && after !== "NE") g.listedAssessedAfter++;
      if (!before && after && after !== "NE") g.listedNewlyAssessed++;
      if (after === "NE") g.listedNotEvaluated++;
      if (!after) g.listedStillMissing++;
      if (before && after && before !== "NE" && after !== "NE" && before !== after) {
        categoryChanges.push({ name: row.scientificName, from: before, to: after });
      }
    }
    if (!sameDecision(row, decision)) updates.push({ row, decision });
  }

  if (opts.apply) {
    // Every catalog species is stamped, changed or not: the stamp says the lookup ran.
    const BATCH = 5000;
    const stampIds = catalog.map((r) => r.id);
    for (let i = 0; i < stampIds.length; i += BATCH) {
      await db.query(`UPDATE species_traits SET iucn_checked_at = now() WHERE species_id = ANY($1::uuid[])`, [
        stampIds.slice(i, i + BATCH),
      ]);
    }
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      // A catalog species without a traits row gets one; source_attribution is required.
      await db.query(
        `INSERT INTO species_traits (species_id, iucn_status, iucn_source, iucn_note, iucn_taxon_id, iucn_checked_at, source_attribution)
         SELECT u.id, u.status, u.source, u.note, u.taxon_id, now(), 'IUCN Red List'
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::bigint[]) AS u(id, status, source, note, taxon_id)
         ON CONFLICT (species_id) DO UPDATE SET
           iucn_status = EXCLUDED.iucn_status, iucn_source = EXCLUDED.iucn_source, iucn_note = EXCLUDED.iucn_note,
           iucn_taxon_id = EXCLUDED.iucn_taxon_id, iucn_checked_at = EXCLUDED.iucn_checked_at`,
        [
          chunk.map((u) => u.row.id),
          chunk.map((u) => u.decision.status),
          chunk.map((u) => u.decision.source),
          chunk.map((u) => u.decision.note),
          chunk.map((u) => u.decision.taxonId),
        ],
      );
    }
  }

  return {
    byMethod,
    byGroup,
    changed: updates.length,
    gbifLookups,
    categoryChanges,
    possibleDuplicates,
    decisions,
    matches,
  };
}
