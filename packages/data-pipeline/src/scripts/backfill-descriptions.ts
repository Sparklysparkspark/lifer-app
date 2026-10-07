// Species descriptions straight from Wikipedia, for every catalog species whose text didn't come
// from the article itself yet: the ones with none (iNaturalist had no summary, or enrichment never
// read one) and the ones holding iNaturalist's cut-off copy of the lead. Each description is
// chosen by the shared rule (packages/core/src/species/descriptionText.ts): the lead and the
// article's Description/Identification section, boilerplate dropped, at most 800 characters,
// whole sentences only. Stored with the CC BY-SA credit, the article URL and the article's
// revision id (species.wikipedia_revision_id, migration 128).
//
// Finding each species' article, cheapest and surest first:
//   1. species.wikipedia_title (Wikidata's sitelink, from the catalog build), the wikipedia_url in
//      the species' cached iNaturalist taxon record, or an older description_source_url;
//   2. Wikidata, by GBIF taxon id (P846) or taxon name (P225), 100 species a query;
//   3. the scientific name as a title (Wikipedia redirects most of them), kept only when the
//      article's lead names the species, so a redirect to the genus page doesn't count.
// Leads come 20 articles a request; an article over 5 kB of wikitext is also fetched whole (one
// request) for its Description section.
//
// Modes:
//   (default)   species with no Wikipedia-sourced text, not looked up in the last
//               --recheck-after-days (90). Each batch is stamped as it goes (wikipedia_checked_at),
//               so a stopped run picks up where it left off.
//   --refresh   species with Wikipedia text: their articles' current revision ids, 50 a request,
//               and a refetch only of articles that changed. Meant for the quarterly refresh.
// Options: --missing-only (skip species that have iNaturalist text), --lead-only (no whole-article
// fetches), --limit=N, --species="Name,Name" (just these), --dry-run (fetch and print, no writes),
// --lang=en (the one language stored today; the fetching is per language for a later i18n stage).
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/backfill-descriptions.ts [--refresh]
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/** A pool or one client (tests run inside a transaction). */
type Db = Pool | PoolClient;
import {
  composeDescription,
  IDENTIFICATION_HEADINGS,
  findSection,
  splitSections,
} from "@lifer/core/species/descriptionText.js";
import {
  articleUrl,
  fetchFullExtract,
  fetchIntros,
  fetchRevisionIds,
  introMatchesSpecies,
  PoliteClient,
  resolveTitlesViaWikidata,
  titleFromWikipediaUrl,
  WikiRateLimitedError,
  type ArticleIntro,
} from "../fetch/wikipediaArticles.js";
import { RateLimitBreaker } from "../pipeline/rateLimitBreaker.js";

export const WIKIPEDIA_DESCRIPTION_CREDIT = "Wikipedia contributors (CC BY-SA)";
/** Articles at least this long (wikitext bytes) are fetched whole for their Description section.
 *  A stub (a taxonomy line, a distribution list, references) runs 1 to 4 kB. */
export const SECTION_MIN_BYTES = 5000;
/** Species per unit of work: looked up, written and stamped together. */
const CHUNK = 200;

export interface SpeciesToDescribe {
  id: string;
  scientific_name: string;
  gbif_key: number | null;
  wikipedia_title: string | null;
  description_source_url: string | null;
  inat_wikipedia_url: string | null;
}

export type Outcome =
  | { kind: "found"; title: string; revId: number; description: string; sourceUrl: string; via: ResolvedVia }
  | { kind: "none" };
export type ResolvedVia = "known-title" | "wikidata" | "scientific-name";

export interface DescribeOptions {
  lang: string;
  /** Fetch long articles whole for their Description section. */
  sections: boolean;
}

export interface Clients {
  wikipedia: PoliteClient;
  wikidata: PoliteClient;
}

/** Titles already on record for a species, best first: the catalog's Wikidata sitelink (English
 *  only), iNaturalist's link, an older description's link. */
export function knownTitles(row: SpeciesToDescribe, lang: string): string[] {
  const titles = [
    lang === "en" ? row.wikipedia_title : null,
    titleFromWikipediaUrl(row.inat_wikipedia_url, lang),
    titleFromWikipediaUrl(row.description_source_url, lang),
  ].filter((t): t is string => !!t && t.trim().length > 0);
  return [...new Set(titles.map((t) => t.trim()))];
}

/** Finds each species' article and composes its description. No database access, so it is
 *  unit-tested with a mocked fetch. */
export async function describeSpecies(
  clients: Clients,
  rows: SpeciesToDescribe[],
  opts: DescribeOptions,
): Promise<Map<string, Outcome>> {
  const found = new Map<string, { intro: ArticleIntro; via: ResolvedVia }>();

  // 1. Titles already on record. iNaturalist's and Wikidata's links are trusted; only a redirect
  //    into a section of another article (a genus page's species list) is refused.
  const known = new Map(rows.map((r) => [r.id, knownTitles(r, opts.lang)]));
  const knownIntros = await fetchIntros(clients.wikipedia, opts.lang, [...known.values()].flat());
  for (const r of rows) {
    for (const t of known.get(r.id) ?? []) {
      const intro = knownIntros.get(t);
      if (intro && !intro.redirectedToSection) {
        found.set(r.id, { intro, via: "known-title" });
        break;
      }
    }
  }

  // 2. Wikidata, by GBIF id or taxon name.
  let rest = rows.filter((r) => !found.has(r.id));
  if (rest.length > 0) {
    const titles = await resolveTitlesViaWikidata(
      clients.wikidata,
      opts.lang,
      rest.map((r) => ({ key: r.id, gbifKey: r.gbif_key, scientificName: r.scientific_name })),
    );
    const intros = await fetchIntros(clients.wikipedia, opts.lang, [...titles.values()]);
    for (const r of rest) {
      const t = titles.get(r.id);
      const intro = t ? intros.get(t) : null;
      if (intro && !intro.redirectedToSection) found.set(r.id, { intro, via: "wikidata" });
    }
  }

  // 3. The scientific name as a title, only when the article is about this species.
  rest = rows.filter((r) => !found.has(r.id));
  if (rest.length > 0) {
    const intros = await fetchIntros(
      clients.wikipedia,
      opts.lang,
      rest.map((r) => r.scientific_name),
    );
    for (const r of rest) {
      const intro = intros.get(r.scientific_name);
      if (intro && introMatchesSpecies(intro, r.scientific_name)) found.set(r.id, { intro, via: "scientific-name" });
    }
  }

  const sections = opts.sections
    ? await fetchIdentificationSections(
        clients.wikipedia,
        opts.lang,
        [...found.values()].map((f) => f.intro),
      )
    : new Map();

  const out = new Map<string, Outcome>();
  for (const r of rows) {
    const f = found.get(r.id);
    const description = f
      ? composeDescription({ lead: f.intro.extract, identificationSection: sections.get(f.intro.title) ?? null })
      : null;
    out.set(
      r.id,
      f && description
        ? {
            kind: "found",
            title: f.intro.title,
            revId: f.intro.lastRevId,
            description,
            sourceUrl: articleUrl(opts.lang, f.intro.title),
            via: f.via,
          }
        : { kind: "none" },
    );
  }
  return out;
}

/** The Description/Identification section of every article long enough to have one, by title. */
export async function fetchIdentificationSections(
  client: PoliteClient,
  lang: string,
  intros: ArticleIntro[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const long = [...new Map(intros.filter((i) => i.length >= SECTION_MIN_BYTES).map((i) => [i.title, i])).values()];
  for (const intro of long) {
    const full = await fetchFullExtract(client, lang, intro.title);
    const section = full ? findSection(splitSections(full), IDENTIFICATION_HEADINGS) : null;
    if (section) out.set(intro.title, section);
  }
  return out;
}

/** Writes one chunk's outcomes: text, credit, link and revision for each article found; the
 *  lookup stamp for every species either way. */
export async function persistOutcomes(db: Db, lang: string, outcomes: Map<string, Outcome>): Promise<void> {
  const found = [...outcomes].filter((e): e is [string, Extract<Outcome, { kind: "found" }>] => e[1].kind === "found");
  if (found.length > 0) {
    await db.query(
      `UPDATE species s SET
         description = v.description,
         description_credit = $6,
         description_source_url = v.url,
         wikipedia_revision_id = v.revid,
         wikipedia_title = CASE WHEN $7 = 'en' THEN v.title ELSE s.wikipedia_title END,
         description_checked_at = now(),
         wikipedia_checked_at = now()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::text[]) AS v(id, description, url, revid, title)
       WHERE s.id = v.id`,
      [
        found.map(([id]) => id),
        found.map(([, o]) => o.description),
        found.map(([, o]) => o.sourceUrl),
        found.map(([, o]) => o.revId),
        found.map(([, o]) => o.title),
        WIKIPEDIA_DESCRIPTION_CREDIT,
        lang,
      ],
    );
  }
  const none = [...outcomes].filter(([, o]) => o.kind === "none").map(([id]) => id);
  if (none.length > 0) {
    await db.query(
      `UPDATE species SET wikipedia_checked_at = now(), description_checked_at = now() WHERE id = ANY($1::uuid[])`,
      [none],
    );
  }
}

export interface BackfillOptions extends DescribeOptions {
  missingOnly: boolean;
  recheckAfterDays: number;
  limit: number | null;
  species: string[] | null;
  dryRun: boolean;
  log: (m: string) => void;
}

export async function selectSpeciesToDescribe(
  db: Db,
  opts: Pick<BackfillOptions, "missingOnly" | "recheckAfterDays" | "limit" | "species">,
): Promise<SpeciesToDescribe[]> {
  const res = await db.query<SpeciesToDescribe>(
    `SELECT s.id, s.scientific_name, s.gbif_key, s.wikipedia_title, s.description_source_url,
            (SELECT substring(c.response from '"wikipedia_url":"([^"]+)"') FROM inat_response_cache c
              WHERE s.inat_taxon_id IS NOT NULL AND c.url = 'https://api.inaturalist.org/v1/taxa/' || s.inat_taxon_id) AS inat_wikipedia_url
     FROM species s
     WHERE NOT s.is_other_taxa
       AND ($4::text[] IS NOT NULL OR (
             s.wikipedia_revision_id IS NULL
             AND (s.wikipedia_checked_at IS NULL OR s.wikipedia_checked_at < now() - make_interval(days => $1::int))
             AND (NOT $2::boolean OR s.description IS NULL)))
       AND ($4::text[] IS NULL OR s.scientific_name = ANY($4))
     -- Species with no text first, then listed ones (what packs ship and people look at).
     ORDER BY (s.description IS NOT NULL),
              NOT EXISTS (SELECT 1 FROM region_species rs WHERE rs.species_id = s.id),
              s.scientific_name
     LIMIT $3`,
    [opts.recheckAfterDays, opts.missingOnly, opts.limit, opts.species],
  );
  return res.rows;
}

export interface RunStats {
  processed: number;
  found: number;
  none: number;
  skippedRateLimited: number;
  stoppedEarly: boolean;
  requests: number;
  byVia: Record<ResolvedVia, number>;
}

const newClients = (): Clients => ({
  wikipedia: new PoliteClient({ minIntervalMs: 100 }),
  // The query service's own etiquette: one query at a time, about a second apart.
  wikidata: new PoliteClient({ minIntervalMs: 1000 }),
});

export async function backfillDescriptions(
  db: Db,
  opts: BackfillOptions,
  clients: Clients = newClients(),
): Promise<RunStats> {
  const rows = await selectSpeciesToDescribe(db, opts);
  opts.log(`[descriptions] ${rows.length} species to look up on ${opts.lang}.wikipedia.org`);
  const stats: RunStats = {
    processed: 0,
    found: 0,
    none: 0,
    skippedRateLimited: 0,
    stoppedEarly: false,
    requests: 0,
    byVia: { "known-title": 0, wikidata: 0, "scientific-name": 0 },
  };
  // Each chunk is one attempt; half of the last ten throttled means the APIs want a rest.
  const breaker = new RateLimitBreaker(10, 0.5);
  const started = Date.now();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    let outcomes: Map<string, Outcome>;
    try {
      outcomes = await describeSpecies(clients, chunk, opts);
      breaker.record(false);
    } catch (err) {
      if (!(err instanceof WikiRateLimitedError)) throw err;
      // Not stamped, so the next run takes these species again.
      stats.skippedRateLimited += chunk.length;
      if (breaker.record(true)) {
        stats.stoppedEarly = true;
        opts.log("[descriptions] Wikipedia or Wikidata keeps refusing; stopping. Rerun later to continue.");
        break;
      }
      continue;
    }
    if (opts.dryRun) {
      for (const r of chunk) {
        const o = outcomes.get(r.id)!;
        opts.log(
          o.kind === "found"
            ? `  ${r.scientific_name} -> ${o.title} (${o.via}, rev ${o.revId}): ${o.description}`
            : `  ${r.scientific_name}: no article`,
        );
      }
    } else {
      await persistOutcomes(db, opts.lang, outcomes);
    }
    for (const o of outcomes.values()) {
      if (o.kind === "found") {
        stats.found++;
        stats.byVia[o.via]++;
      } else stats.none++;
    }
    stats.processed += chunk.length;
    const perSpeciesMs = (Date.now() - started) / stats.processed;
    const etaMin = Math.round((perSpeciesMs * (rows.length - stats.processed)) / 60000);
    opts.log(
      `[descriptions] ${stats.processed}/${rows.length}: ${stats.found} with text, ${stats.none} without; ~${etaMin} min left`,
    );
  }
  stats.requests = clients.wikipedia.requests + clients.wikidata.requests;
  opts.log(
    `[descriptions] done: ${stats.found} described (${stats.byVia["known-title"]} by a known title, ${stats.byVia.wikidata} via Wikidata, ` +
      `${stats.byVia["scientific-name"]} by scientific name), ${stats.none} without an article, ${stats.skippedRateLimited} left for the next run; ` +
      `${stats.requests} requests in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  return stats;
}

export interface RevisionCheck {
  id: string;
  wikipedia_title: string;
  wikipedia_revision_id: number;
}

/** Which species' articles changed: a different revision, a rename (redirect), or gone. */
export function changedArticles(
  rows: RevisionCheck[],
  current: Map<string, { title: string; lastRevId: number } | null>,
): { changed: RevisionCheck[]; gone: RevisionCheck[] } {
  const changed: RevisionCheck[] = [];
  const gone: RevisionCheck[] = [];
  for (const r of rows) {
    const now = current.get(r.wikipedia_title);
    if (now === undefined) continue; // not asked (unusable title): left alone
    if (now === null) gone.push(r);
    else if (now.lastRevId !== Number(r.wikipedia_revision_id) || now.title !== r.wikipedia_title) changed.push(r);
  }
  return { changed, gone };
}

export async function refreshChangedDescriptions(
  db: Db,
  opts: Pick<BackfillOptions, "lang" | "sections" | "limit" | "species" | "dryRun" | "log">,
  clients: Clients = newClients(),
): Promise<{ checked: number; changed: number; updated: number; gone: number; requests: number }> {
  const res = await db.query<RevisionCheck & { scientific_name: string }>(
    `SELECT id, scientific_name, wikipedia_title, wikipedia_revision_id FROM species
     WHERE wikipedia_revision_id IS NOT NULL AND wikipedia_title IS NOT NULL AND NOT is_other_taxa
       AND ($2::text[] IS NULL OR scientific_name = ANY($2))
     ORDER BY scientific_name LIMIT $1`,
    [opts.limit, opts.species],
  );
  opts.log(`[descriptions] checking ${res.rows.length} articles for new revisions`);
  const current = await fetchRevisionIds(
    clients.wikipedia,
    opts.lang,
    res.rows.map((r) => r.wikipedia_title),
  );
  const { changed, gone } = changedArticles(res.rows, current);
  opts.log(`[descriptions] ${changed.length} changed, ${gone.length} gone`);

  let updated = 0;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK);
    const titles = chunk.map((r) => current.get(r.wikipedia_title)!.title);
    const intros = await fetchIntros(clients.wikipedia, opts.lang, titles);
    const valid = [...intros.values()].filter((x): x is ArticleIntro => x !== null);
    const sections = opts.sections
      ? await fetchIdentificationSections(clients.wikipedia, opts.lang, valid)
      : new Map<string, string>();
    const outcomes = new Map<string, Outcome>();
    for (const r of chunk) {
      const intro = intros.get(current.get(r.wikipedia_title)!.title);
      const description = intro
        ? composeDescription({ lead: intro.extract, identificationSection: sections.get(intro.title) ?? null })
        : null;
      if (intro && description) {
        outcomes.set(r.id, {
          kind: "found",
          title: intro.title,
          revId: intro.lastRevId,
          description,
          sourceUrl: articleUrl(opts.lang, intro.title),
          via: "known-title",
        });
        updated++;
      }
    }
    if (opts.dryRun) {
      for (const [id, o] of outcomes)
        if (o.kind === "found") opts.log(`  ${id} -> ${o.title} rev ${o.revId}: ${o.description}`);
    } else {
      await persistOutcomes(db, opts.lang, outcomes);
    }
  }
  // An article that's gone keeps its text until a fill run finds the new one.
  if (gone.length > 0 && !opts.dryRun) {
    await db.query(
      `UPDATE species SET wikipedia_revision_id = NULL, wikipedia_checked_at = NULL WHERE id = ANY($1::uuid[])`,
      [gone.map((g) => g.id)],
    );
  }
  const requests = clients.wikipedia.requests + clients.wikidata.requests;
  opts.log(`[descriptions] refresh done: ${updated} updated, ${gone.length} articles gone, ${requests} requests`);
  return { checked: res.rows.length, changed: changed.length, updated, gone: gone.length, requests };
}

export function parseArgs(argv: string[]) {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const limit = value("limit");
  const days = Number(value("recheck-after-days") ?? 90);
  if (!Number.isFinite(days) || days < 0) throw new Error("--recheck-after-days must be a number of days");
  const lang = value("lang") ?? "en";
  if (!/^[a-z]{2,3}(-[a-z]+)?$/.test(lang)) throw new Error(`--lang=${lang} isn't a Wikipedia language code`);
  return {
    refresh: argv.includes("--refresh"),
    lang,
    sections: !argv.includes("--lead-only"),
    missingOnly: argv.includes("--missing-only"),
    recheckAfterDays: days,
    limit: limit ? Number(limit) : null,
    species:
      value("species")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? null,
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Descriptions are stored in one language today; the lookups already take a language so a later
  // i18n stage can store per-language text.
  if (args.lang !== "en") throw new Error("Only --lang=en is stored today (species.description is English)");
  const { pool } = await import("../db.js");
  try {
    if (args.refresh) await refreshChangedDescriptions(pool, { ...args, log: console.log });
    else await backfillDescriptions(pool, { ...args, log: console.log });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
