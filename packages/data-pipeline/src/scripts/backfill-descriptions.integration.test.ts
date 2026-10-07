// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Each test rolls
// back. Wikipedia and Wikidata are faked; what's under test is selection, writes and resume.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoliteClient } from "../fetch/wikipediaArticles.js";
import { backfillDescriptions, refreshChangedDescriptions, selectSpeciesToDescribe } from "./backfill-descriptions.js";

const url = process.env.TEST_DATABASE_URL;

const PAGES: Record<string, { pageid: number; extract: string; lastrevid: number; length: number }> = {
  "Common garter snake": {
    pageid: 1,
    extract: "The common garter snake (Thamnophis sirtalis) is a species of snake. Most have yellow stripes on a black background.",
    lastrevid: 100,
    length: 3000,
  },
  "Great blue heron": { pageid: 2, extract: "The great blue heron (Ardea herodias) is a large wading bird with a dagger-like bill.", lastrevid: 200, length: 3000 },
};
const REDIRECTS: Record<string, string> = { "Thamnophis sirtalis": "Common garter snake" };

function fakeClients() {
  const wiki = vi.fn(async (input: string | URL | Request) => {
    const params = new URL(String(input)).searchParams;
    const redirects: Array<{ from: string; to: string }> = [];
    const pages = params.get("titles")!.split("|").map((t) => {
      const to = REDIRECTS[t];
      if (to) redirects.push({ from: t, to });
      const p = PAGES[to ?? t];
      return p ? { ...p, title: to ?? t } : { title: to ?? t, missing: true };
    });
    return new Response(JSON.stringify({ query: { redirects, pages } }), { status: 200 });
  });
  const wikidata = vi.fn(async () => new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 }));
  const opts = { minIntervalMs: 0, wait: async () => {} };
  return {
    wikipedia: new PoliteClient({ ...opts, fetchImpl: wiki as unknown as typeof fetch }),
    wikidata: new PoliteClient({ ...opts, fetchImpl: wikidata as unknown as typeof fetch }),
  };
}

describe.skipIf(!url)("backfill-descriptions on a database", () => {
  const db = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;
  const log = () => {};
  const base = { lang: "en", sections: true, missingOnly: false, recheckAfterDays: 90, limit: null, species: null, dryRun: false, log };

  beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
    // Only this test's species are candidates.
    await client.query(`UPDATE species SET wikipedia_checked_at = now() WHERE wikipedia_checked_at IS NULL`);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await db.end();
  });

  async function species(name: string, cols: Record<string, unknown> = {}) {
    const keys = Object.keys(cols);
    const res = await client.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, taxon_class${keys.map((k) => `, ${k}`).join("")})
       VALUES ((random() * 1e9)::int, $1, 'aves'${keys.map((_, i) => `, $${i + 2}`).join("")}) RETURNING id`,
      [name, ...Object.values(cols)],
    );
    return res.rows[0].id;
  }
  // Selections are checked against this test's own species only, so rows another test file has
  // in the shared database can't change what's expected.
  const mine = (rows: Array<{ id: string }>, ids: string[]) =>
    rows
      .map((r) => r.id)
      .filter((id) => ids.includes(id))
      .sort();
  const row = async (id: string) =>
    (
      await client.query(
        `SELECT description, description_credit, description_source_url, wikipedia_title, wikipedia_revision_id,
                description_checked_at, wikipedia_checked_at FROM species WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it("fills text from the article, replacing iNaturalist's cut-off copy, and stamps species with none", async () => {
    const snake = await species("Thamnophis sirtalis", { inat_taxon_id: 28362, enriched_at: new Date() });
    await client.query(`INSERT INTO inat_response_cache (url, response) VALUES ($1, $2) ON CONFLICT (url) DO UPDATE SET response = EXCLUDED.response`, [
      "https://api.inaturalist.org/v1/taxa/28362",
      JSON.stringify({ results: [{ id: 28362, wikipedia_url: "https://en.wikipedia.org/wiki/Thamnophis sirtalis" }] }),
    ]);
    const heron = await species("Ardea herodias", {
      wikipedia_title: "Great blue heron",
      description: "The great blue heron is a bird. It was once treated as a separate species...",
      description_credit: "Wikipedia contributors (CC BY-SA), via iNaturalist",
      description_source_url: "https://en.wikipedia.org/wiki/Ardea herodias",
    });
    const none = await species("Nullus nullus");

    const stats = await backfillDescriptions(client, base, fakeClients());
    expect(stats).toMatchObject({ processed: 3, found: 2, none: 1 });

    expect(await row(snake)).toMatchObject({
      description: "Most have yellow stripes on a black background.",
      description_credit: "Wikipedia contributors (CC BY-SA)",
      description_source_url: "https://en.wikipedia.org/wiki/Common_garter_snake",
      wikipedia_title: "Common garter snake",
      wikipedia_revision_id: "100",
    });
    expect((await row(snake)).description_checked_at).not.toBeNull();
    expect(await row(heron)).toMatchObject({
      description: "The great blue heron (Ardea herodias) is a large wading bird with a dagger-like bill.",
      wikipedia_revision_id: "200",
    });
    const nothing = await row(none);
    expect(nothing.description).toBeNull();
    expect(nothing.wikipedia_checked_at).not.toBeNull();
    expect(nothing.description_checked_at).not.toBeNull();

    // Resume-safe: a second run has nothing left to do.
    expect(mine(await selectSpeciesToDescribe(client, base), [snake, heron, none])).toEqual([]);
  });

  it("leaves Other Taxa, Wikipedia-sourced and recently checked species alone; --missing-only skips iNaturalist text", async () => {
    const other = await species("Zzdesc other", { is_other_taxa: true });
    const sourced = await species("Zzdesc sourced", { wikipedia_revision_id: 5 });
    const recent = await species("Zzdesc recent", { wikipedia_checked_at: new Date() });
    const stale = await species("Zzdesc stale", { wikipedia_checked_at: new Date(Date.now() - 200 * 86400_000) });
    const inat = await species("Zzdesc inat", {
      description: "Some text.",
      description_credit: "Wikipedia contributors (CC BY-SA), via iNaturalist",
      description_source_url: "https://en.wikipedia.org/wiki/X",
    });
    const created = [other, sourced, recent, stale, inat];
    expect(mine(await selectSpeciesToDescribe(client, base), created)).toEqual([stale, inat].sort());
    expect(mine(await selectSpeciesToDescribe(client, { ...base, missingOnly: true }), created)).toEqual([stale]);
  });

  it("--refresh refetches only articles whose revision changed, and forgets deleted ones", async () => {
    const same = await species("Ardea herodias", { wikipedia_title: "Great blue heron", wikipedia_revision_id: 200, description: "Old.", description_credit: "c", description_source_url: "u" });
    const edited = await species("Thamnophis sirtalis", {
      wikipedia_title: "Common garter snake",
      wikipedia_revision_id: 90,
      description: "Old snake text.",
      description_credit: "c",
      description_source_url: "u",
    });
    const deleted = await species("Zzdesc deleted", { wikipedia_title: "Deleted page", wikipedia_revision_id: 7, wikipedia_checked_at: new Date() });

    const result = await refreshChangedDescriptions(client, { ...base, species: ["Ardea herodias", "Thamnophis sirtalis", "Zzdesc deleted"] }, fakeClients());
    expect(result).toMatchObject({ checked: 3, changed: 1, updated: 1, gone: 1 });
    expect(await row(same)).toMatchObject({ description: "Old.", wikipedia_revision_id: "200" });
    expect(await row(edited)).toMatchObject({ description: "Most have yellow stripes on a black background.", wikipedia_revision_id: "100" });
    expect(await row(deleted)).toMatchObject({ wikipedia_revision_id: null, wikipedia_checked_at: null });
  });
});
