// English Wikipedia pageviews for every tiered species with an article (species.wikipedia_title),
// over the last 60 days scaled to a year, into species_traits.wiki_pageviews_12mo. Public
// interest, used to correct photo-based tiers: a species few people care about is photographed
// far less often than it's found (migration 117). Resumable and cheap to rerun: species fetched
// in the last 90 days are skipped.
//
// Usage: npx tsx src/scripts/fetch-wiki-pageviews.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const UA = "lifer-app/0.1 (species interest for rarity tiers; https://github.com/Sparklysparkspark/lifer-app)";
const TIERED = ["aves", "mammalia", "actinopterygii", "amphibia", "squamata", "testudines"];

const DAYS = 60;

/** Pageviews over the last 60 days for up to 50 articles in one request (Wikipedia's action API,
 *  prop=pageviews), following redirects. Returns views by the title as asked. */
export async function pageviewsBatch(titles: string[]): Promise<Map<string, number>> {
  const base = { action: "query", prop: "pageviews", pvipdays: String(DAYS), redirects: "1", format: "json", formatversion: "2", titles: titles.join("|") };
  // The API returns pageviews for only part of a batch per response and says to continue for
  // the rest; a page without them yet is not a page with none.
  const viewsByPage = new Map<string, number>();
  const missing = new Set<string>();
  const normalized = new Map<string, string>();
  const redirects = new Map<string, string>();
  let cont: Record<string, string> | null = {};
  for (let round = 0; cont && round < 20; round++) {
    const params: URLSearchParams = new URLSearchParams({ ...base, ...cont });
    let data: {
      continue?: Record<string, string>;
      query?: {
        normalized?: Array<{ from: string; to: string }>;
        redirects?: Array<{ from: string; to: string }>;
        pages?: Array<{ title: string; missing?: boolean; pageviews?: Record<string, number | null> }>;
      };
    } | null = null;
    for (let attempt = 0; attempt < 6 && !data; attempt++) {
      try {
        const res: Response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
        if (res.status === 429 || res.status >= 500) {
          const wait = Number(res.headers.get("retry-after")) || 30 * (attempt + 1);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (!res.ok) return new Map();
        data = await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
      }
    }
    if (!data) return new Map();
    const q = data.query ?? {};
    for (const n of q.normalized ?? []) normalized.set(n.from, n.to);
    for (const r of q.redirects ?? []) redirects.set(r.from, r.to);
    for (const p of q.pages ?? []) {
      if (p.missing) missing.add(p.title);
      else if (p.pageviews) viewsByPage.set(p.title, Object.values(p.pageviews).reduce<number>((a, b) => a + (b ?? 0), 0));
    }
    cont = data.continue ?? null;
    if (cont) await new Promise((r) => setTimeout(r, 300));
  }
  const out = new Map<string, number>();
  for (const t of titles) {
    let resolved = normalized.get(t) ?? t;
    resolved = redirects.get(resolved) ?? resolved;
    if (viewsByPage.has(resolved)) out.set(t, viewsByPage.get(resolved)!);
    else if (missing.has(resolved)) out.set(t, 0);
  }
  return out;
}

export async function fetchWikiPageviews(log: (m: string) => void = console.log): Promise<number> {
  const rows = await pool.query<{ id: string; wikipedia_title: string }>(
    `SELECT s.id, s.wikipedia_title FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE s.wikipedia_title IS NOT NULL AND s.taxon_class = ANY($1) AND NOT s.is_other_taxa
       AND (t.wiki_pageviews_at IS NULL OR t.wiki_pageviews_at < now() - interval '90 days')`,
    [TIERED],
  );
  log(`[wiki-pageviews] ${rows.rows.length} species to fetch (last ${DAYS} days, stored as a yearly figure)`);
  let done = 0;
  const BATCH = 50;
  for (let i = 0; i < rows.rows.length; i += BATCH) {
    const batch = rows.rows.slice(i, i + BATCH);
    const views = await pageviewsBatch(batch.map((r) => r.wikipedia_title));
    const ok = batch.filter((r) => views.has(r.wikipedia_title));
    await pool.query(
      `UPDATE species_traits t SET wiki_pageviews_12mo = v.n, wiki_pageviews_at = now()
       FROM unnest($1::uuid[], $2::int[]) AS v(id, n) WHERE t.species_id = v.id`,
      [ok.map((r) => r.id), ok.map((r) => Math.round((views.get(r.wikipedia_title)! * 365) / DAYS))],
    );
    done += ok.length;
    if ((i / BATCH) % 40 === 0) log(`[wiki-pageviews] ${done}/${rows.rows.length}`);
    // Polite pace for Wikipedia's API: one request at a time, about two a second.
    await new Promise((r) => setTimeout(r, 500));
  }
  return done;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fetchWikiPageviews()
    .then(async (n) => {
      console.log(`[wiki-pageviews] ${n} species updated`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
