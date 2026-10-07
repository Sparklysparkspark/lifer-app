// Wikipedia article text and revisions, and Wikidata title lookups, for species descriptions
// (scripts/backfill-descriptions.ts, fetch-wikipedia-summary.ts) and, later, habitat text and
// other languages. Every function takes the language's client, so an i18n stage can run the same
// code per language.
//
// API etiquette (https://www.mediawiki.org/wiki/API:Etiquette): one request at a time, a
// descriptive User-Agent with a contact, maxlag=5 so the servers can shed us under replication
// lag, and batching: prop=extracts with exintro returns up to 20 pages a request (its exlimit),
// prop=info up to 50. A whole-article extract is one page a request, so it is only fetched for
// articles long enough to have sections. Responses are never cached: a refresh has to see the
// current revision.
//
// License: article text is CC BY-SA 4.0. Callers store the credit and a link to the article
// with every description (species.description_requires_credit).
import { setTimeout as sleep } from "node:timers/promises";
import { findSection, splitSections } from "@lifer/core/species/descriptionText.js";

export const WIKI_USER_AGENT = "LiferDataPipeline/0.9 (https://github.com/Sparklysparkspark/lifer-app; species descriptions)";
/** prop=extracts' exlimit with exintro (the API's maximum). */
export const INTRO_BATCH = 20;
/** Titles per prop=info request (the API's maximum for non-bot clients). */
export const INFO_BATCH = 50;
/** GBIF ids and names per Wikidata query. */
export const WIKIDATA_BATCH = 100;

/** Thrown when the API is still refusing (429, 503 or maxlag) after every retry. */
export class WikiRateLimitedError extends Error {}

export interface PoliteClientOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** The least time between two requests from this client. */
  minIntervalMs?: number;
  maxRetries?: number;
  /** For tests: replaces the waits between retries. */
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** One request at a time, paced, retried on throttling and server errors. */
export class PoliteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  /** Requests sent, retries included. */
  requests = 0;

  constructor(opts: PoliteClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? WIKI_USER_AGENT;
    this.minIntervalMs = opts.minIntervalMs ?? 100;
    this.maxRetries = opts.maxRetries ?? 5;
    this.wait = opts.wait ?? ((ms) => sleep(ms));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** GETs (or POSTs a form body) and parses JSON. MediaWiki's maxlag answer is a 200 with
   *  error.code "maxlag", retried like a 429. */
  json<T>(url: string, form?: Record<string, string>): Promise<T> {
    const run = this.queue.then(() => this.send<T>(url, form));
    this.queue = run.catch(() => {});
    return run;
  }

  private async send<T>(url: string, form?: Record<string, string>): Promise<T> {
    let throttled = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const gap = this.lastAt + this.minIntervalMs - Date.now();
      if (gap > 0) await this.wait(gap);
      this.lastAt = Date.now();
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: form ? "POST" : "GET",
          headers: {
            "User-Agent": this.userAgent,
            "Api-User-Agent": this.userAgent,
            Accept: "application/json",
            ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          body: form ? new URLSearchParams(form).toString() : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        throttled = false;
        await this.wait(1000 * 2 ** attempt);
        continue;
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      if (res.status === 429 || res.status === 503) {
        throttled = true;
        await res.body?.cancel().catch(() => {});
        await this.wait(Math.min(backoff, 120_000));
        continue;
      }
      if (res.status >= 500) {
        throttled = false;
        lastError = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        await res.body?.cancel().catch(() => {});
        await this.wait(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body = (await res.json()) as T & { error?: { code?: string; info?: string } };
      if (body.error?.code === "maxlag") {
        throttled = true;
        await this.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000);
        continue;
      }
      if (body.error) throw new Error(`API error ${body.error.code}: ${body.error.info}`);
      return body;
    }
    if (throttled) throw new WikiRateLimitedError(`still throttled after ${this.maxRetries} retries: ${new URL(url).host}`);
    throw lastError ?? new Error(`request failed: ${url}`);
  }
}

export const wikipediaApi = (lang: string) => `https://${lang}.wikipedia.org/w/api.php`;

/** The article's canonical URL, as stored in description_source_url. */
export function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

/** The article title in a Wikipedia URL of that language (iNaturalist's wikipedia_url, an old
 *  description_source_url), or null for any other host. */
export function titleFromWikipediaUrl(url: string | null | undefined, lang: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.replace(/ /g, "_"));
    if (u.hostname !== `${lang}.wikipedia.org` && u.hostname !== `${lang}.m.wikipedia.org`) return null;
    const m = /^\/wiki\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    const title = decodeURIComponent(m[1]).replace(/_/g, " ").trim();
    return title || null;
  } catch {
    return null;
  }
}

// Titles MediaWiki can't take in a titles= list.
const isUsableTitle = (t: string) => t.length > 0 && t.length <= 255 && !/[|#<>[\]{}]/.test(t);

export interface ArticleIntro {
  /** The title as asked for. */
  requestedTitle: string;
  /** The article's canonical title, after normalization and redirects. */
  title: string;
  pageId: number;
  lastRevId: number;
  /** Wikitext length in bytes: a stub is a couple of kB. */
  length: number;
  /** The lead as plain text. */
  extract: string;
  wikibaseItem: string | null;
  disambiguation: boolean;
  /** The title reached the article through a redirect. */
  redirected: boolean;
  /** The redirect pointed at a section of another article (a genus page's species list). */
  redirectedToSection: boolean;
}

interface QueryPage {
  pageid?: number;
  title: string;
  missing?: boolean;
  invalid?: boolean;
  extract?: string;
  lastrevid?: number;
  length?: number;
  pageprops?: { wikibase_item?: string; disambiguation?: string };
}
interface QueryResponse {
  continue?: Record<string, string>;
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string; tofragment?: string }>;
    pages?: QueryPage[];
  };
}

/** Follows normalization and redirects from each requested title to the page title it landed on. */
function resolveRequested(
  requested: string[],
  query: NonNullable<QueryResponse["query"]>,
): Map<string, { target: string; redirected: boolean; toSection: boolean }> {
  const normalized = new Map((query.normalized ?? []).map((n) => [n.from, n.to]));
  const redirects = new Map((query.redirects ?? []).map((r) => [r.from, r]));
  const out = new Map<string, { target: string; redirected: boolean; toSection: boolean }>();
  for (const t of requested) {
    let target = normalized.get(t) ?? t;
    let redirected = false;
    let toSection = false;
    for (let hops = 0; hops < 5 && redirects.has(target); hops++) {
      const r = redirects.get(target)!;
      redirected = true;
      if (r.tofragment) toSection = true;
      target = r.to;
    }
    out.set(t, { target, redirected, toSection });
  }
  return out;
}

/** Leads (plain text), revision ids and Wikidata items for up to any number of titles, 20 to a
 *  request. Missing, invalid and disambiguation pages map to null. */
export async function fetchIntros(client: PoliteClient, lang: string, titles: string[]): Promise<Map<string, ArticleIntro | null>> {
  const out = new Map<string, ArticleIntro | null>();
  const unique = [...new Set(titles)];
  for (const t of unique) if (!isUsableTitle(t)) out.set(t, null);
  const usable = unique.filter(isUsableTitle);
  for (let i = 0; i < usable.length; i += INTRO_BATCH) {
    const batch = usable.slice(i, i + INTRO_BATCH);
    const pages = new Map<string, QueryPage>();
    let resolved: ReturnType<typeof resolveRequested> | null = null;
    let cont: Record<string, string> = {};
    // A batch's extracts can come back over several continuations.
    for (let round = 0; round < 10; round++) {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        maxlag: "5",
        redirects: "1",
        prop: "extracts|info|pageprops",
        exintro: "1",
        explaintext: "1",
        exlimit: String(INTRO_BATCH),
        ppprop: "wikibase_item|disambiguation",
        titles: batch.join("|"),
        ...cont,
      });
      const data = await client.json<QueryResponse>(`${wikipediaApi(lang)}?${params}`);
      if (!data.query) break;
      resolved ??= resolveRequested(batch, data.query);
      for (const p of data.query.pages ?? []) {
        const prior = pages.get(p.title);
        pages.set(p.title, { ...prior, ...p, extract: p.extract ?? prior?.extract });
      }
      if (!data.continue) break;
      cont = data.continue;
    }
    for (const t of batch) {
      const r = resolved?.get(t);
      const page = r ? pages.get(r.target) : undefined;
      if (!r || !page || page.missing || page.invalid || !page.pageid || page.pageprops?.disambiguation !== undefined) {
        out.set(t, null);
        continue;
      }
      out.set(t, {
        requestedTitle: t,
        title: page.title,
        pageId: page.pageid,
        lastRevId: page.lastrevid ?? 0,
        length: page.length ?? 0,
        extract: (page.extract ?? "").trim(),
        wikibaseItem: page.pageprops?.wikibase_item ?? null,
        disambiguation: false,
        redirected: r.redirected,
        redirectedToSection: r.toSection,
      });
    }
  }
  return out;
}

/** The whole article as plain text with "== Heading ==" markers, one article per request. */
export async function fetchFullExtract(client: PoliteClient, lang: string, title: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    maxlag: "5",
    redirects: "1",
    prop: "extracts",
    explaintext: "1",
    exsectionformat: "wiki",
    titles: title,
  });
  const data = await client.json<QueryResponse>(`${wikipediaApi(lang)}?${params}`);
  const page = data.query?.pages?.[0];
  return page && !page.missing && page.extract ? page.extract : null;
}

/** The body of the article's first section whose heading has one of `headings` in it (see
 *  descriptionText.ts findSection), or null. One request. */
export async function fetchArticleSection(client: PoliteClient, lang: string, title: string, headings: readonly string[]): Promise<string | null> {
  const full = await fetchFullExtract(client, lang, title);
  return full ? findSection(splitSections(full), headings) : null;
}

/** Current revision ids for titles, 50 to a request, following redirects. Missing pages map to
 *  null; a title that now redirects maps to its target's title and revision. */
export async function fetchRevisionIds(
  client: PoliteClient,
  lang: string,
  titles: string[],
): Promise<Map<string, { title: string; lastRevId: number } | null>> {
  const out = new Map<string, { title: string; lastRevId: number } | null>();
  const unique = [...new Set(titles)];
  for (const t of unique) if (!isUsableTitle(t)) out.set(t, null);
  const usable = unique.filter(isUsableTitle);
  for (let i = 0; i < usable.length; i += INFO_BATCH) {
    const batch = usable.slice(i, i + INFO_BATCH);
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      maxlag: "5",
      redirects: "1",
      prop: "info",
      titles: batch.join("|"),
    });
    const data = await client.json<QueryResponse>(`${wikipediaApi(lang)}?${params}`);
    const resolved = data.query ? resolveRequested(batch, data.query) : new Map();
    const pages = new Map((data.query?.pages ?? []).map((p) => [p.title, p]));
    for (const t of batch) {
      const page = pages.get(resolved.get(t)?.target ?? t);
      out.set(t, page && !page.missing && page.lastrevid ? { title: page.title, lastRevId: page.lastrevid } : null);
    }
  }
  return out;
}

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

const sparqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Article titles in `lang` for species, from Wikidata: by GBIF taxon id (P846) first, then by
 *  taxon name (P225). A key whose id or name leads to more than one article is left out rather
 *  than guessed. Returns key to title. */
export async function resolveTitlesViaWikidata(
  client: PoliteClient,
  lang: string,
  items: Array<{ key: string; gbifKey: number | null; scientificName: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < items.length; i += WIKIDATA_BATCH) {
    const batch = items.slice(i, i + WIKIDATA_BATCH);
    const gbifs = batch.filter((b) => b.gbifKey != null).map((b) => sparqlString(String(b.gbifKey)));
    const names = batch.map((b) => sparqlString(b.scientificName));
    const query = `SELECT ?gbif ?name ?title WHERE {
  { VALUES ?gbif { ${gbifs.join(" ")} } ?item wdt:P846 ?gbif . }
  UNION
  { VALUES ?name { ${names.join(" ")} } ?item wdt:P225 ?name . }
  ?article schema:about ?item ; schema:isPartOf <https://${lang}.wikipedia.org/> ; schema:name ?title .
}`;
    const data = await client.json<{ results: { bindings: Array<{ gbif?: { value: string }; name?: { value: string }; title: { value: string } }> } }>(
      WIKIDATA_SPARQL,
      { query, format: "json" },
    );
    const byGbif = new Map<string, Set<string>>();
    const byName = new Map<string, Set<string>>();
    for (const b of data.results.bindings) {
      if (b.gbif) byGbif.set(b.gbif.value, (byGbif.get(b.gbif.value) ?? new Set()).add(b.title.value));
      if (b.name) byName.set(b.name.value, (byName.get(b.name.value) ?? new Set()).add(b.title.value));
    }
    for (const b of batch) {
      const viaGbif = b.gbifKey != null ? byGbif.get(String(b.gbifKey)) : undefined;
      const viaName = byName.get(b.scientificName);
      const pick = viaGbif?.size === 1 ? viaGbif : viaName?.size === 1 ? viaName : null;
      if (pick) out.set(b.key, [...pick][0]);
    }
  }
  return out;
}

/** Whether an article found by looking up the species' scientific name is about that species:
 *  the title is the name, or the lead mentions the binomial (a redirect to the genus article
 *  doesn't). Redirects to a section of another article never count. */
export function introMatchesSpecies(intro: ArticleIntro, scientificName: string): boolean {
  if (intro.redirectedToSection) return false;
  const name = scientificName.toLowerCase().trim();
  if (intro.title.toLowerCase() === name) return true;
  return intro.extract.toLowerCase().replace(/\s+/g, " ").includes(name);
}
