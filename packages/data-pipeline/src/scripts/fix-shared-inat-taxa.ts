// Gives every iNaturalist taxon to at most one catalog species.
//
// Older name matching linked several catalog species to the one taxon iNaturalist lumps them into
// (Passerella unalaschcensis, schistacea and megarhyncha onto Fox Sparrow), so they showed the
// same photos and text and iNaturalist checklists confirmed all of them. For each shared taxon:
//   owner   the species iNaturalist's name (or an authority) says the taxon is keeps it.
//   relink  a species iNaturalist has its own taxon for, under exactly its name, moves to it.
//   merge   a species the authority counts as the owner (eBird for birds, Catalogue of Life for the
//           rest) is folded into it through species-merges.tsv, so its checklists and records move
//           there and its names stay searchable as synonyms and aliases.
//   unlink  a species the authority keeps apart loses the link, and the photos and text it
//           borrowed from the owner, until enrichment finds its own.
// Every decision goes to data/review/shared-inat-taxa.tsv. Changes nothing without --apply.
//
//   npx tsx src/scripts/fix-shared-inat-taxa.ts [--apply] [--report=<plan.json>]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpFetch } from "@lifer/core/lib/http.js";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { pool } from "../db.js";
import { inatGet } from "../inatApi.js";
import { ebirdFormsByBinomial, epithetStem, loadEbird } from "./add-missing-species.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const MERGES_TSV = path.join(DATA_DIR, "reference", "species-merges.tsv");
const REVIEW_TSV = path.join(DATA_DIR, "review", "shared-inat-taxa.tsv");
const LOOKUP_CACHE = path.join(DATA_DIR, "build", "shared-inat-taxa-lookups.json");
const COL_MATCH_URL = "https://api.checklistbank.org/dataset/3LXR/match/nameusage";

export interface Member {
  id: string;
  name: string;
  commonName: string | null;
  taxonClass: string | null;
  ebirdCode: string | null;
  occurrences: number;
  synonyms: string[];
  /** Main photo and gallery URLs. */
  photos: string[];
  description: string | null;
}

export interface Group {
  inatTaxonId: number;
  members: Member[];
}

export interface ColName {
  status: string;
  accepted: string | null;
}

export interface Lookups {
  /** Shared taxon id to iNaturalist's name for it. */
  inatName: Map<number, string>;
  /** Catalog name to the active iNaturalist species named exactly that, null when there is none. */
  ownInat: Map<string, number | null>;
  /** iNaturalist id to the catalog species holding it, for every linked species. */
  heldBy: Map<number, string>;
  ebirdSpecies: Set<string>;
  /** Binomial of an eBird group or subspecies to the eBird species code it is reported as. */
  ebirdForms: Map<string, string>;
  /** Catalogue of Life's verdict on a name, null when it doesn't know the name. */
  col: Map<string, ColName | null>;
}

export type Category = "a_merge" | "a_keep" | "b" | "c" | "owner" | "review";

export interface Decision {
  speciesId: string;
  name: string;
  inatTaxonId: number;
  action: "keep" | "relink" | "merge" | "unlink";
  category: Category;
  newInatTaxonId?: number;
  intoId?: string;
  intoName?: string;
  reason: string;
  /** Photo URLs it shares with another species of the group. */
  borrowedPhotos: string[];
  borrowedDescription: boolean;
}

const lower = (s: string) => s.toLowerCase();

/** The same name respelled (greyi/greyae) or moved to another genus (Flammeo/Neoniphon marianus). */
// Merges whose right target isn't the species iNaturalist lumps them with: eBird files the name
// under another species. Checked against eBird's taxonomy.
export const EBIRD_MERGE_TARGETS: Record<string, { into: string; reason: string }> = {
  "Picumnus nigropunctatus": {
    into: "Picumnus squamulatus",
    reason: "eBird counts Black-dotted Piculet as a group of Scaled Piculet, not Golden-spangled",
  },
};

/** Points the merges in EBIRD_MERGE_TARGETS at eBird's species, given catalog names to ids. */
export function retargetMerges(decisions: Decision[], idByName: Map<string, string>): Decision[] {
  return decisions.map((d) => {
    const fix = d.action === "merge" ? EBIRD_MERGE_TARGETS[d.name] : undefined;
    const intoId = fix && idByName.get(fix.into);
    return fix && intoId ? { ...d, intoId, intoName: fix.into, reason: fix.reason } : d;
  });
}

export function sameNameVariant(a: string, b: string): boolean {
  const [ga, ea] = lower(a).split(" ");
  const [gb, eb] = lower(b).split(" ");
  return ga === gb ? epithetStem(ea) === epithetStem(eb) : ea === eb;
}

/** Catalogue of Life's accepted name for a member, or its own name when it is accepted there. */
function colAccepted(m: Member, lk: Lookups): string | null {
  const c = lk.col.get(m.name);
  if (!c) return null;
  return c.status === "accepted" ? m.name : c.accepted;
}

export function planGroup(group: Group, lk: Lookups): Decision[] {
  const T = group.inatTaxonId;
  const inatName = lk.inatName.get(T) ?? null;
  const isBird = group.members.every((m) => m.taxonClass === "aves");
  const out: Decision[] = [];
  const borrowed = (m: Member) => {
    const others = group.members.filter((o) => o.id !== m.id);
    const theirs = new Set(others.flatMap((o) => o.photos));
    return {
      borrowedPhotos: m.photos.filter((p) => theirs.has(p)),
      borrowedDescription: !!m.description && others.some((o) => o.description === m.description),
    };
  };
  const decide = (
    m: Member,
    d: Omit<Decision, "speciesId" | "name" | "inatTaxonId" | keyof ReturnType<typeof borrowed>>,
  ) => out.push({ speciesId: m.id, name: m.name, inatTaxonId: T, ...d, ...borrowed(m) });

  // (b) iNaturalist has the species under exactly its own name: it moves to that taxon.
  const rest: Member[] = [];
  for (const m of group.members) {
    const own = lk.ownInat.get(m.name);
    if (own == null || own === T) {
      rest.push(m);
      continue;
    }
    const holder = lk.heldBy.get(own);
    if (holder && holder !== m.id)
      decide(m, {
        action: "unlink",
        category: "review",
        reason: `its own iNaturalist taxon ${own} is on another catalog species`,
      });
    else
      decide(m, { action: "relink", category: "b", newInatTaxonId: own, reason: `iNaturalist has it as taxon ${own}` });
  }
  if (rest.length === 0) return out;

  // The owner: the only one the authority accepts as a species, else iNaturalist's name for the
  // taxon (or a synonym of it), else the most recorded.
  const accepted = rest.filter((m) => (isBird ? lk.ebirdSpecies.has(m.name) : colAccepted(m, lk) === m.name));
  const byName = inatName ? rest.find((m) => lower(m.name) === lower(inatName)) : undefined;
  const bySynonym = inatName ? rest.find((m) => m.synonyms.some((s) => lower(s) === lower(inatName))) : undefined;
  const owner =
    (accepted.length === 1 ? accepted[0] : undefined) ??
    byName ??
    bySynonym ??
    [...rest].sort((a, b) => b.occurrences - a.occurrences)[0];
  const how =
    accepted.length === 1 && accepted[0] === owner
      ? `the only one ${isBird ? "eBird" : "Catalogue of Life"} accepts as a species`
      : owner === byName
        ? "named as iNaturalist names the taxon"
        : owner === bySynonym
          ? "iNaturalist's name for the taxon is its synonym"
          : "the most recorded";
  decide(owner, { action: "keep", category: "owner", reason: `keeps the taxon: ${how}` });

  for (const m of rest) {
    if (m === owner) continue;
    const into = { intoId: owner.id, intoName: owner.name };
    if (isBird) {
      const form = lk.ebirdForms.get(m.name);
      if (lk.ebirdSpecies.has(m.name))
        decide(m, {
          action: "unlink",
          category: "a_keep",
          reason: `eBird counts it as its own species; iNaturalist lumps it into ${inatName}`,
        });
      else if (form && form === owner.ebirdCode)
        decide(m, {
          action: "merge",
          category: "a_merge",
          ...into,
          reason: `eBird counts it as a group of ${owner.name}`,
        });
      else if (owner.ebirdCode)
        decide(m, {
          action: "merge",
          category: "c",
          ...into,
          reason: `not an eBird species; iNaturalist treats it as ${inatName}`,
        });
      else decide(m, { action: "unlink", category: "review", reason: "neither name is an eBird species" });
      continue;
    }
    const mine = colAccepted(m, lk);
    const theirs = colAccepted(owner, lk);
    if (sameNameVariant(m.name, owner.name))
      decide(m, { action: "merge", category: "c", ...into, reason: `a spelling or genus variant of ${owner.name}` });
    else if (mine && (mine === theirs || mine === owner.name || mine === inatName))
      decide(m, {
        action: "merge",
        category: "c",
        ...into,
        reason: `Catalogue of Life and iNaturalist both treat it as ${owner.name}`,
      });
    else if (mine === m.name)
      decide(m, {
        action: "unlink",
        category: "a_keep",
        reason: `Catalogue of Life accepts it as a species; iNaturalist lumps it into ${inatName}`,
      });
    else
      decide(m, {
        action: "unlink",
        category: "review",
        reason: mine ? `Catalogue of Life names it ${mine}` : "Catalogue of Life doesn't know the name",
      });
  }
  return out;
}

// ---------- lookups ----------

type Cache = {
  inatName: Record<string, string>;
  ownInat: Record<string, number | null>;
  col: Record<string, ColName | null>;
};

function loadCache(): Cache {
  return existsSync(LOOKUP_CACHE)
    ? (JSON.parse(readFileSync(LOOKUP_CACHE, "utf8")) as Cache)
    : { inatName: {}, ownInat: {}, col: {} };
}
const saveCache = (c: Cache) => {
  mkdirSync(path.dirname(LOOKUP_CACHE), { recursive: true });
  writeFileSync(LOOKUP_CACHE, JSON.stringify(c));
};

async function colLookup(name: string): Promise<ColName | null> {
  const res = await httpFetch(`${COL_MATCH_URL}?scientificName=${encodeURIComponent(name)}`, {
    init: { headers: { Accept: "application/json" } },
    maxRetries: 5,
    retryServerErrors: true,
  });
  if (!res.ok) throw new Error(`${res.status} from Catalogue of Life for ${name}`);
  const u = (
    (await res.json()) as {
      usage?: {
        status?: string;
        accepted?: { name?: { scientificName?: string } };
        classification?: Array<{ rank?: string; status?: string; name?: string }>;
      };
    }
  ).usage;
  if (!u?.status) return null;
  const species = (u.classification ?? []).find((c) => c.rank === "species" && c.status === "accepted")?.name;
  return {
    status: u.status,
    accepted: u.status === "accepted" ? name : (species ?? u.accepted?.name?.scientificName ?? null),
  };
}

/** Everything the planner reads from iNaturalist and Catalogue of Life, cached on disk so a rerun
 *  asks only for what it hasn't seen. */
async function fetchLookups(groups: Group[]): Promise<Lookups> {
  const cache = loadCache();
  const ids = groups.map((g) => g.inatTaxonId).filter((id) => !(id in cache.inatName));
  for (let i = 0; i < ids.length; i += 30) {
    const page = await inatGet<{ results: Array<{ id: number; name: string }> }>(
      `https://api.inaturalist.org/v1/taxa/${ids.slice(i, i + 30).join(",")}`,
    );
    for (const t of page.results) cache.inatName[t.id] = t.name;
    saveCache(cache);
  }
  const inatName = new Map(Object.entries(cache.inatName).map(([k, v]) => [Number(k), v]));
  const members = groups.flatMap((g) => g.members.map((m) => ({ m, g })));
  let n = 0;
  for (const { m, g } of members) {
    if (m.name in cache.ownInat) continue;
    if (lower(m.name) === lower(inatName.get(g.inatTaxonId) ?? "")) {
      cache.ownInat[m.name] = g.inatTaxonId;
      continue;
    }
    const page = await inatGet<{ results: Array<{ id: number; name: string; rank?: string; is_active?: boolean }> }>(
      `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(m.name)}&rank=species&is_active=true&per_page=10`,
    );
    cache.ownInat[m.name] = page.results.find((r) => lower(r.name) === lower(m.name))?.id ?? null;
    if (++n % 25 === 0) {
      saveCache(cache);
      console.log(`[fix-shared-inat-taxa] iNaturalist: ${n} names looked up`);
    }
  }
  for (const { m } of members.filter(({ m }) => m.taxonClass !== "aves" && !(m.name in cache.col))) {
    cache.col[m.name] = await colLookup(m.name);
    if (++n % 25 === 0) saveCache(cache);
  }
  saveCache(cache);

  const held = await pool.query<{ inat_taxon_id: number; id: string }>(
    `SELECT inat_taxon_id, id FROM species WHERE inat_taxon_id IS NOT NULL AND NOT is_other_taxa`,
  );
  const ebird = loadEbird();
  return {
    inatName,
    ownInat: new Map(Object.entries(cache.ownInat)),
    heldBy: new Map(held.rows.map((r) => [r.inat_taxon_id, r.id])),
    ebirdSpecies: new Set(ebird.filter((r) => r.category === "species").map((r) => r.sci)),
    ebirdForms: ebirdFormsByBinomial(ebird),
    col: new Map(Object.entries(cache.col)),
  };
}

export async function loadSharedGroups(): Promise<Group[]> {
  const res = await pool.query<Member & { inat_taxon_id: number }>(
    `SELECT s.inat_taxon_id, s.id, s.scientific_name AS name, s.common_name AS "commonName",
            s.taxon_class AS "taxonClass", s.ebird_code AS "ebirdCode",
            COALESCE(t.occurrence_count, 0)::int AS occurrences, s.description,
            ARRAY(SELECT synonym_name FROM species_synonyms y WHERE y.species_id = s.id) AS synonyms,
            ARRAY(SELECT u FROM (SELECT s.reference_photo AS u UNION
                  SELECT photo_url FROM species_reference_photos p WHERE p.species_id = s.id) x WHERE u IS NOT NULL) AS photos
       FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
      WHERE NOT s.is_other_taxa AND s.inat_taxon_id IN (
        SELECT inat_taxon_id FROM species WHERE NOT is_other_taxa AND inat_taxon_id IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1)
      ORDER BY s.inat_taxon_id, s.scientific_name`,
  );
  const groups = new Map<number, Group>();
  for (const { inat_taxon_id, ...m } of res.rows) {
    const g = groups.get(inat_taxon_id) ?? { inatTaxonId: inat_taxon_id, members: [] };
    g.members.push(m);
    groups.set(inat_taxon_id, g);
  }
  return [...groups.values()];
}

// ---------- apply ----------

/** The merges as species-merges.tsv rows, leaving out species the file already merges away (a
 *  species that is only some earlier merge's target still needs its own row). */
export function mergeRows(decisions: Decision[], existingTsv: string): string[] {
  const mergedAway = new Set(existingTsv.split("\n").map((line) => line.split("\t")[0]));
  return decisions
    .filter((d) => d.action === "merge" && !mergedAway.has(d.speciesId))
    .map((d) =>
      [d.speciesId, d.name, d.intoId, d.intoName, `Shared iNaturalist taxon ${d.inatTaxonId}: ${d.reason}`].join("\t"),
    );
}

async function apply(decisions: Decision[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockReferenceData(client);
    for (const d of decisions) {
      if (d.action !== "relink" && d.action !== "unlink") continue;
      // Only while it still holds the taxon this plan was made from.
      const res = await client.query(`UPDATE species SET inat_taxon_id = $3 WHERE id = $1 AND inat_taxon_id = $2`, [
        d.speciesId,
        d.inatTaxonId,
        d.newInatTaxonId ?? null,
      ]);
      if (!res.rowCount) continue;
      if (d.borrowedPhotos.length > 0) {
        await client.query(
          `UPDATE species SET reference_photo = NULL, reference_credit = NULL, reference_license = NULL,
             reference_display_path = NULL, reference_thumb_path = NULL, reference_focal_x = NULL,
             reference_focal_y = NULL, photo_withheld = false, photo_checked_at = NULL, enriched_at = NULL,
             gallery_backfilled_at = NULL
           WHERE id = $1 AND reference_photo = ANY($2)`,
          [d.speciesId, d.borrowedPhotos],
        );
        await client.query(`DELETE FROM species_reference_photos WHERE species_id = $1 AND photo_url = ANY($2)`, [
          d.speciesId,
          d.borrowedPhotos,
        ]);
        await client.query(
          `DELETE FROM species_reference_embeddings WHERE species_id = $1 AND NOT EXISTS (SELECT 1 FROM species WHERE id = $1 AND reference_photo IS NOT NULL)`,
          [d.speciesId],
        );
        await client.query(
          `DELETE FROM id_model_reference_embeddings WHERE species_id = $1 AND NOT EXISTS (SELECT 1 FROM species WHERE id = $1 AND reference_photo IS NOT NULL)`,
          [d.speciesId],
        );
      }
      if (d.borrowedDescription) {
        await client.query(
          `UPDATE species SET description = NULL, description_credit = NULL, description_source_url = NULL,
             description_checked_at = NULL, wikipedia_title = NULL, wikipedia_revision_id = NULL, wikipedia_checked_at = NULL,
             enriched_at = NULL
           WHERE id = $1`,
          [d.speciesId],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // The merges themselves run in the catalog stage's merge step, from the reviewed list.
  const rows = mergeRows(decisions, readFileSync(MERGES_TSV, "utf8"));
  if (rows.length > 0) appendFileSync(MERGES_TSV, `${rows.join("\n")}\n`);
  console.log(`[fix-shared-inat-taxa] applied; ${rows.length} merges added to ${path.relative(DATA_DIR, MERGES_TSV)}`);
}

async function main() {
  const doApply = process.argv.includes("--apply");
  const report = process.argv.find((a) => a.startsWith("--report="))?.slice("--report=".length);
  const groups = await loadSharedGroups();
  console.log(`[fix-shared-inat-taxa] ${groups.length} iNaturalist taxa are on more than one catalog species`);
  if (groups.length === 0) return;
  const lk = await fetchLookups(groups);
  const targets = Object.values(EBIRD_MERGE_TARGETS).map((t) => t.into);
  const targetIds = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE scientific_name = ANY($1) AND NOT is_other_taxa`,
    [targets],
  );
  const decisions = retargetMerges(
    groups.flatMap((g) => planGroup(g, lk)),
    new Map(targetIds.rows.map((r) => [r.scientific_name, r.id])),
  );

  // An applied run keeps its own record, so it never replaces the list that was reviewed.
  const decisionsTsv = doApply
    ? REVIEW_TSV.replace(/\.tsv$/, `-applied-${new Date().toISOString().slice(0, 16).replace(":", "")}.tsv`)
    : REVIEW_TSV;
  mkdirSync(path.dirname(decisionsTsv), { recursive: true });
  writeFileSync(
    decisionsTsv,
    [
      "inat_taxon_id\tinat_name\tspecies_id\tname\taction\tcategory\tinto_or_new_id\tborrowed_photos\treason",
      ...decisions.map((d) =>
        [
          d.inatTaxonId,
          lk.inatName.get(d.inatTaxonId) ?? "",
          d.speciesId,
          d.name,
          d.action,
          d.category,
          d.intoName ?? d.newInatTaxonId ?? "",
          d.borrowedPhotos.length,
          d.reason,
        ].join("\t"),
      ),
    ].join("\n") + "\n",
  );
  if (report)
    writeFileSync(report, JSON.stringify({ groups, decisions, inatName: Object.fromEntries(lk.inatName) }, null, 1));
  const count = (a: string) => decisions.filter((d) => d.action === a).length;
  console.log(
    `[fix-shared-inat-taxa] keep ${count("keep")}, relink ${count("relink")}, merge ${count("merge")}, unlink ${count("unlink")}; every decision in ${path.relative(DATA_DIR, decisionsTsv)}`,
  );
  if (doApply) await apply(decisions);
  else console.log("[fix-shared-inat-taxa] preview only (pass --apply)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
