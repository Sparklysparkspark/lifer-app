import { describe, expect, it, vi } from "vitest";
import {
  articleUrl,
  fetchIntros,
  fetchRevisionIds,
  introMatchesSpecies,
  PoliteClient,
  resolveTitlesViaWikidata,
  titleFromWikipediaUrl,
  WikiRateLimitedError,
  type ArticleIntro,
} from "./wikipediaArticles.js";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const noWait = async () => {};

function client(handler: (url: URL, body: URLSearchParams | null) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init?.body ? new URLSearchParams(String(init.body)) : null),
  );
  return {
    c: new PoliteClient({ fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 0, wait: noWait }),
    fetchImpl,
  };
}

// A fake MediaWiki that knows a few pages and redirects, answering prop=extracts|info queries.
const PAGES: Record<
  string,
  { pageid: number; extract: string; lastrevid: number; length: number; disambiguation?: boolean }
> = {
  "Common garter snake": {
    pageid: 1,
    extract: "The common garter snake (Thamnophis sirtalis) is a snake.",
    lastrevid: 100,
    length: 29000,
  },
  "Great blue heron": {
    pageid: 2,
    extract: "The great blue heron (Ardea herodias) is a large wading bird.",
    lastrevid: 200,
    length: 39000,
  },
  "Garter snake": {
    pageid: 3,
    extract: "Garter snake is the common name for snakes of the genus Thamnophis.",
    lastrevid: 300,
    length: 34000,
  },
  Mercury: { pageid: 4, extract: "Mercury may refer to:", lastrevid: 400, length: 900, disambiguation: true },
};
const REDIRECTS: Record<string, { to: string; tofragment?: string }> = {
  "Thamnophis sirtalis": { to: "Common garter snake" },
  "Ardea herodias": { to: "Great blue heron" },
  "Thamnophis fakeus": { to: "Garter snake" },
  "Conus obscurus": { to: "Conus", tofragment: "Species" },
};
function fakeWiki(url: URL): Response {
  const titles = url.searchParams.get("titles")!.split("|");
  const normalized: Array<{ from: string; to: string }> = [];
  const redirects: Array<{ from: string; to: string; tofragment?: string }> = [];
  const pages = new Map<string, object>();
  for (const raw of titles) {
    let t = raw.replace(/_/g, " ");
    if (t !== raw) normalized.push({ from: raw, to: t });
    const r = REDIRECTS[t];
    if (r) {
      redirects.push({ from: t, ...r });
      t = r.to;
    }
    const p = PAGES[t];
    pages.set(
      t,
      p
        ? {
            pageid: p.pageid,
            title: t,
            extract: url.searchParams.get("prop")?.includes("extracts") ? p.extract : undefined,
            lastrevid: p.lastrevid,
            length: p.length,
            ...(p.disambiguation ? { pageprops: { disambiguation: "" } } : {}),
          }
        : { title: t, missing: true },
    );
  }
  return json({ batchcomplete: true, query: { normalized, redirects, pages: [...pages.values()] } });
}

describe("fetchIntros", () => {
  it("batches 20 titles a request", async () => {
    const { c, fetchImpl } = client((url) => fakeWiki(url));
    const titles = Array.from({ length: 45 }, (_, i) => `Missing title ${i}`);
    const out = await fetchIntros(c, "en", titles);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sizes = fetchImpl.mock.calls.map(([u]) => new URL(String(u)).searchParams.get("titles")!.split("|").length);
    expect(sizes).toEqual([20, 20, 5]);
    expect(out.size).toBe(45);
    const params = new URL(String(fetchImpl.mock.calls[0][0])).searchParams;
    expect(params.get("exintro")).toBe("1");
    expect(params.get("maxlag")).toBe("5");
    expect(params.get("exlimit")).toBe("20");
  });

  it("maps each requested title through normalization and redirects", async () => {
    const { c } = client((url) => fakeWiki(url));
    const out = await fetchIntros(c, "en", [
      "Thamnophis sirtalis",
      "Common_garter_snake",
      "Ardea herodias",
      "Nope nope",
      "Mercury",
      "Conus obscurus",
    ]);
    expect(out.get("Thamnophis sirtalis")).toMatchObject({
      title: "Common garter snake",
      lastRevId: 100,
      redirected: true,
      length: 29000,
    });
    expect(out.get("Common_garter_snake")).toMatchObject({ title: "Common garter snake", redirected: false });
    expect(out.get("Ardea herodias")?.extract).toMatch(/great blue heron/);
    expect(out.get("Nope nope")).toBeNull();
    expect(out.get("Mercury")).toBeNull(); // disambiguation
    expect(out.get("Conus obscurus")).toBeNull(); // the genus page doesn't exist in this fake
  });

  it("follows extract continuations within a batch", async () => {
    let call = 0;
    const { c } = client((url) => {
      call++;
      const base = { pageid: 1, title: "Great blue heron", lastrevid: 200, length: 5 };
      if (!url.searchParams.get("excontinue")) {
        return json({
          continue: { excontinue: "1", continue: "||" },
          query: {
            pages: [base, { pageid: 2, title: "Common garter snake", lastrevid: 1, length: 5, extract: "Snake." }],
          },
        });
      }
      return json({
        query: {
          pages: [
            { ...base, extract: "Heron." },
            { pageid: 2, title: "Common garter snake", lastrevid: 1, length: 5 },
          ],
        },
      });
    });
    const out = await fetchIntros(c, "en", ["Great blue heron", "Common garter snake"]);
    expect(call).toBe(2);
    expect(out.get("Great blue heron")?.extract).toBe("Heron.");
    expect(out.get("Common garter snake")?.extract).toBe("Snake.");
  });
});

describe("PoliteClient", () => {
  it("retries maxlag and 429 answers, then succeeds", async () => {
    let n = 0;
    const { c } = client(() => {
      n++;
      if (n === 1) return json({ error: { code: "maxlag", info: "Waiting" } }, { headers: { "retry-after": "1" } });
      if (n === 2) return new Response("slow down", { status: 429 });
      return json({ ok: true });
    });
    await expect(c.json("https://en.wikipedia.org/w/api.php?x=1")).resolves.toEqual({ ok: true });
    expect(c.requests).toBe(3);
  });

  it("gives up with WikiRateLimitedError when throttling never stops", async () => {
    const { c } = client(() => new Response("slow down", { status: 429 }));
    await expect(c.json("https://en.wikipedia.org/w/api.php")).rejects.toBeInstanceOf(WikiRateLimitedError);
  });

  it("sends a descriptive User-Agent", async () => {
    const { c, fetchImpl } = client(() => json({}));
    await c.json("https://en.wikipedia.org/w/api.php");
    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Lifer.*github\.com/);
  });
});

describe("fetchRevisionIds", () => {
  it("asks 50 titles a request and reports renames and missing pages", async () => {
    const { c, fetchImpl } = client((url) => fakeWiki(url));
    const titles = ["Thamnophis sirtalis", "Great blue heron", ...Array.from({ length: 60 }, (_, i) => `Gone ${i}`)];
    const out = await fetchRevisionIds(c, "en", titles);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("prop")).toBe("info");
    expect(out.get("Thamnophis sirtalis")).toEqual({ title: "Common garter snake", lastRevId: 100 });
    expect(out.get("Great blue heron")).toEqual({ title: "Great blue heron", lastRevId: 200 });
    expect(out.get("Gone 3")).toBeNull();
  });
});

describe("resolveTitlesViaWikidata", () => {
  it("prefers the GBIF id match and skips ambiguous keys", async () => {
    const { c, fetchImpl } = client((_url, body) => {
      expect(body!.get("query")).toContain('"2457522"');
      return json({
        results: {
          bindings: [
            { gbif: { value: "2457522" }, title: { value: "Common garter snake" } },
            { name: { value: "Thamnophis sirtalis" }, title: { value: "Common garter snake" } },
            { name: { value: "Ambiguus duplex" }, title: { value: "Page one" } },
            { name: { value: "Ambiguus duplex" }, title: { value: "Page two" } },
            { name: { value: "Ardea herodias" }, title: { value: "Great blue heron" } },
          ],
        },
      });
    });
    const out = await resolveTitlesViaWikidata(c, "en", [
      { key: "a", gbifKey: 2457522, scientificName: "Thamnophis sirtalis" },
      { key: "b", gbifKey: null, scientificName: "Ambiguus duplex" },
      { key: "c", gbifKey: 9999, scientificName: "Ardea herodias" },
    ]);
    expect(fetchImpl.mock.calls[0][1]!.method).toBe("POST");
    expect(out).toEqual(
      new Map([
        ["a", "Common garter snake"],
        ["c", "Great blue heron"],
      ]),
    );
  });
});

describe("titles and URLs", () => {
  it("reads titles from Wikipedia URLs of the right language only", () => {
    expect(titleFromWikipediaUrl("https://en.wikipedia.org/wiki/Thamnophis sirtalis", "en")).toBe(
      "Thamnophis sirtalis",
    );
    expect(titleFromWikipediaUrl("http://en.wikipedia.org/wiki/Worm_pipefish", "en")).toBe("Worm pipefish");
    expect(titleFromWikipediaUrl("https://en.wikipedia.org/wiki/Bewick%27s_wren", "en")).toBe("Bewick's wren");
    expect(titleFromWikipediaUrl("https://fr.wikipedia.org/wiki/H%C3%A9ron", "en")).toBeNull();
    expect(titleFromWikipediaUrl("https://example.org/wiki/X", "en")).toBeNull();
    expect(titleFromWikipediaUrl(null, "en")).toBeNull();
  });

  it("builds the article URL the app links to", () => {
    expect(articleUrl("en", "Common garter snake")).toBe("https://en.wikipedia.org/wiki/Common_garter_snake");
    expect(articleUrl("en", "Bewick's wren")).toBe("https://en.wikipedia.org/wiki/Bewick's_wren");
  });

  it("accepts a scientific-name lookup only when the article is about the species", () => {
    const intro = (title: string, extract: string, redirectedToSection = false) =>
      ({ title, extract, redirectedToSection }) as ArticleIntro;
    expect(
      introMatchesSpecies(
        intro("Common garter snake", "The common garter snake (Thamnophis sirtalis) is..."),
        "Thamnophis sirtalis",
      ),
    ).toBe(true);
    expect(
      introMatchesSpecies(
        intro("Garter snake", "Garter snake is the common name for the genus Thamnophis."),
        "Thamnophis fakeus",
      ),
    ).toBe(false);
    expect(
      introMatchesSpecies(intro("Turbonilla acuta", "Turbonilla acuta is a species of sea snail."), "Turbonilla acuta"),
    ).toBe(true);
    expect(introMatchesSpecies(intro("Conus", "Conus obscurus and others", true), "Conus obscurus")).toBe(false);
  });
});
