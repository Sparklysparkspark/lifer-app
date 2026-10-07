import { describe, expect, it, vi } from "vitest";
import { PoliteClient } from "../fetch/wikipediaArticles.js";
import {
  changedArticles,
  describeSpecies,
  knownTitles,
  parseArgs,
  type SpeciesToDescribe,
} from "./backfill-descriptions.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const LONG_ARTICLE = `The common garter snake (Thamnophis sirtalis) is a species of snake in the family Colubridae. Most have yellow stripes on a black background.

== Taxonomy ==
There are 12 subspecies.

== Anatomy and description ==
Common garter snakes are thin snakes. Few grow over about 4 ft (1.2 m) long.`;

const PAGES: Record<string, { pageid: number; extract: string; lastrevid: number; length: number }> = {
  "Common garter snake": { pageid: 1, extract: LONG_ARTICLE.split("\n\n==")[0], lastrevid: 100, length: 29000 },
  "Great blue heron": {
    pageid: 2,
    extract: "The great blue heron (Ardea herodias) is a large wading bird with a dagger-like bill.",
    lastrevid: 200,
    length: 4000,
  },
  "Garter snake": {
    pageid: 3,
    extract: "Garter snake is the common name for small snakes of the genus Thamnophis.",
    lastrevid: 300,
    length: 3000,
  },
  "Turbonilla acuta": {
    pageid: 4,
    extract: "Turbonilla acuta is a species of sea snail, a marine gastropod mollusk in the family Pyramidellidae.",
    lastrevid: 400,
    length: 2200,
  },
  "Quillback rockfish": {
    pageid: 5,
    extract: "The quillback rockfish is a species of fish. Their mottled orange-brown coloring blends with reefs.",
    lastrevid: 500,
    length: 4000,
  },
};
const REDIRECTS: Record<string, string> = {
  "Thamnophis sirtalis": "Common garter snake",
  "Thamnophis fakeus": "Garter snake",
};

function fakeClients(wikidata: Record<string, string> = {}) {
  const wikiCalls: URLSearchParams[] = [];
  const wikidataCalls: string[] = [];
  const wikiFetch = vi.fn(async (input: string | URL | Request) => {
    const params = new URL(String(input)).searchParams;
    wikiCalls.push(params);
    const redirects: Array<{ from: string; to: string }> = [];
    const pages = params
      .get("titles")!
      .split("|")
      .map((t) => {
        const to = REDIRECTS[t];
        if (to) redirects.push({ from: t, to });
        const title = to ?? t;
        const p = PAGES[title];
        if (!p) return { title, missing: true };
        const whole = params.get("exintro") !== "1" && params.get("prop") === "extracts";
        return {
          ...p,
          title,
          extract: whole ? (title === "Common garter snake" ? LONG_ARTICLE : p.extract) : p.extract,
        };
      });
    return json({ query: { redirects, pages } });
  });
  const wikidataFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const query = new URLSearchParams(String(init!.body)).get("query")!;
    wikidataCalls.push(query);
    const bindings = Object.entries(wikidata)
      .filter(([name]) => query.includes(`"${name}"`))
      .map(([name, title]) => ({ name: { value: name }, title: { value: title } }));
    return json({ results: { bindings } });
  });
  const opts = { minIntervalMs: 0, wait: async () => {} };
  return {
    clients: {
      wikipedia: new PoliteClient({ ...opts, fetchImpl: wikiFetch as unknown as typeof fetch }),
      wikidata: new PoliteClient({ ...opts, fetchImpl: wikidataFetch as unknown as typeof fetch }),
    },
    wikiCalls,
    wikidataCalls,
  };
}

const row = (id: string, name: string, extra: Partial<SpeciesToDescribe> = {}): SpeciesToDescribe => ({
  id,
  scientific_name: name,
  gbif_key: null,
  wikipedia_title: null,
  description_source_url: null,
  inat_wikipedia_url: null,
  ...extra,
});

describe("knownTitles", () => {
  it("orders the catalog title, iNaturalist's link and an older description link, without repeats", () => {
    const r = row("1", "Thamnophis sirtalis", {
      wikipedia_title: "Common garter snake",
      inat_wikipedia_url: "https://en.wikipedia.org/wiki/Thamnophis sirtalis",
      description_source_url: "https://en.wikipedia.org/wiki/Common_garter_snake",
    });
    expect(knownTitles(r, "en")).toEqual(["Common garter snake", "Thamnophis sirtalis"]);
    // wikipedia_title is English Wikipedia's; another language uses links in that language only.
    expect(knownTitles(r, "fr")).toEqual([]);
  });
});

describe("describeSpecies", () => {
  it("uses a known title, and Wikidata only for species without one", async () => {
    const { clients, wikidataCalls } = fakeClients({ "Sebastes maliger": "Quillback rockfish" });
    const out = await describeSpecies(
      clients,
      [row("heron", "Ardea herodias", { wikipedia_title: "Great blue heron" }), row("fish", "Sebastes maliger")],
      { lang: "en", sections: true },
    );
    expect(out.get("heron")).toMatchObject({
      kind: "found",
      via: "known-title",
      title: "Great blue heron",
      revId: 200,
      sourceUrl: "https://en.wikipedia.org/wiki/Great_blue_heron",
    });
    expect(out.get("fish")).toMatchObject({
      kind: "found",
      via: "wikidata",
      title: "Quillback rockfish",
      description: PAGES["Quillback rockfish"].extract,
    }); // "Their ..." keeps the sentence naming it
    expect(wikidataCalls).toHaveLength(1);
    expect(wikidataCalls[0]).toContain('"Sebastes maliger"');
    expect(wikidataCalls[0]).not.toContain('"Ardea herodias"');
  });

  it("tries the scientific name last and keeps it only when the article names the species", async () => {
    const { clients } = fakeClients();
    const out = await describeSpecies(
      clients,
      [
        row("snake", "Thamnophis sirtalis"),
        row("fake", "Thamnophis fakeus"),
        row("snail", "Turbonilla acuta"),
        row("none", "Nullus nullus"),
      ],
      {
        lang: "en",
        sections: true,
      },
    );
    expect(out.get("snake")).toMatchObject({ kind: "found", via: "scientific-name", title: "Common garter snake" });
    expect(out.get("fake")).toEqual({ kind: "none" }); // redirected to the genus article
    // A stub with only a taxonomy line still gets it.
    expect(out.get("snail")).toMatchObject({ kind: "found", description: PAGES["Turbonilla acuta"].extract });
    expect(out.get("none")).toEqual({ kind: "none" });
  });

  it("fetches only long articles whole, for their Description section", async () => {
    const { clients, wikiCalls } = fakeClients();
    const out = await describeSpecies(
      clients,
      [
        row("snake", "Thamnophis sirtalis", { wikipedia_title: "Common garter snake" }),
        row("heron", "Ardea herodias", { wikipedia_title: "Great blue heron" }),
      ],
      { lang: "en", sections: true },
    );
    const whole = wikiCalls.filter((p) => p.get("exintro") !== "1");
    expect(whole.map((p) => p.get("titles"))).toEqual(["Common garter snake"]);
    const snake = out.get("snake");
    expect(snake?.kind === "found" && snake.description).toBe(
      "Most have yellow stripes on a black background. Common garter snakes are thin snakes. Few grow over about 4 ft (1.2 m) long.",
    );
  });

  it("with sections off, never fetches a whole article", async () => {
    const { clients, wikiCalls } = fakeClients();
    await describeSpecies(clients, [row("snake", "Thamnophis sirtalis", { wikipedia_title: "Common garter snake" })], {
      lang: "en",
      sections: false,
    });
    expect(wikiCalls.every((p) => p.get("exintro") === "1")).toBe(true);
  });
});

describe("changedArticles", () => {
  const rows = [
    { id: "same", wikipedia_title: "Great blue heron", wikipedia_revision_id: 200 },
    { id: "edited", wikipedia_title: "Common garter snake", wikipedia_revision_id: 99 },
    { id: "renamed", wikipedia_title: "Old name", wikipedia_revision_id: 5 },
    { id: "deleted", wikipedia_title: "Deleted page", wikipedia_revision_id: 7 },
    { id: "unasked", wikipedia_title: "Bad|title", wikipedia_revision_id: 8 },
  ];
  const current = new Map<string, { title: string; lastRevId: number } | null>([
    ["Great blue heron", { title: "Great blue heron", lastRevId: 200 }],
    ["Common garter snake", { title: "Common garter snake", lastRevId: 100 }],
    ["Old name", { title: "New name", lastRevId: 5 }],
    ["Deleted page", null],
  ]);

  it("refetches edited and renamed articles only, and reports deleted ones", () => {
    const { changed, gone } = changedArticles(rows, current);
    expect(changed.map((r) => r.id)).toEqual(["edited", "renamed"]);
    expect(gone.map((r) => r.id)).toEqual(["deleted"]);
  });

  it("compares bigint revision ids that pg returns as strings", () => {
    const { changed } = changedArticles(
      [{ id: "same", wikipedia_title: "Great blue heron", wikipedia_revision_id: "200" as unknown as number }],
      current,
    );
    expect(changed).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("defaults to English, sections on, a 90-day recheck", () => {
    expect(parseArgs([])).toMatchObject({
      refresh: false,
      lang: "en",
      sections: true,
      recheckAfterDays: 90,
      limit: null,
      species: null,
      dryRun: false,
    });
  });

  it("reads every option", () => {
    expect(
      parseArgs([
        "--refresh",
        "--lead-only",
        "--missing-only",
        "--limit=50",
        "--species=Ardea herodias,Thamnophis sirtalis",
        "--dry-run",
        "--lang=de",
      ]),
    ).toMatchObject({
      refresh: true,
      sections: false,
      missingOnly: true,
      limit: 50,
      species: ["Ardea herodias", "Thamnophis sirtalis"],
      dryRun: true,
      lang: "de",
    });
    expect(() => parseArgs(["--lang=../x"])).toThrow();
  });
});
