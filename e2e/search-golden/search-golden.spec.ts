// One table of golden queries run through the Gallery search, the Command-K palette and the
// Collection filter (support/searchGolden.json, on the library in support/searchGoldenSeed.ts).
// Assertions are on species sets, never order: scene ranking depends on CLIP.
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import golden from "../support/searchGolden.json" with { type: "json" };
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { EXTREME_ACCOUNT, SEED_COLLECTION } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { GOLDEN_SPECIES, seedSearchGolden } from "../support/searchGoldenSeed.js";

interface Golden {
  q: string;
  kind: string;
  include?: string[];
  exclude?: string[];
  only?: string[];
  none?: boolean;
  fewerThan?: number;
  sameAs?: string;
  count?: number;
  surfaces: string[];
}
const QUERIES = golden.queries as Golden[];
const NAMES = GOLDEN_SPECIES.map((s) => s.common);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    await seedSearchGolden(db);
  } finally {
    await db.end();
  }
});

test.beforeEach(async ({ page }, info) => {
  markKnownFailure(info);
  const res = await page.context().request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT });
  expect(res.ok()).toBe(true);
});

interface Hit {
  commonName: string | null;
}
async function galleryHits(page: Page, q: string, quick: boolean): Promise<Hit[]> {
  const res = await page.request.get("/api/gallery/search", { params: { q, ...(quick ? { quick: "1" } : {}) } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: Hit[] }).items;
}
const speciesOf = (hits: Hit[]) => [...new Set(hits.map((h) => h.commonName ?? ""))].sort();

// Reads a page area once its debounced search has landed: the text is the same three reads running.
async function settledText(read: () => Promise<string>): Promise<string> {
  let last = "";
  let same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await read();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last;
}

// The golden names whose text shows up in the visible text of a page area.
const namesIn = (text: string) => NAMES.filter((n) => text.includes(n)).sort();

function check(entry: Golden, got: string[], count?: number): void {
  const label = `"${entry.q}"`;
  if (entry.none) expect(got, `${label} finds nothing`).toEqual([]);
  if (entry.only) expect(got, `${label} finds exactly these`).toEqual([...entry.only].sort());
  for (const n of entry.include ?? []) expect(got, `${label} includes ${n}`).toContain(n);
  for (const n of entry.exclude ?? []) expect(got, `${label} excludes ${n}`).not.toContain(n);
  if (entry.fewerThan !== undefined && count !== undefined)
    expect(count, `${label} is a filter, not the whole library`).toBeLessThan(entry.fewerThan);
  if (entry.count !== undefined && count !== undefined) expect(count, `${label} photo count`).toBe(entry.count);
}

for (const entry of QUERIES.filter((e) => e.surfaces.includes("gallery"))) {
  test(`gallery: ${entry.q}`, async ({ page }) => {
    const hits = await galleryHits(page, entry.q, false);
    check(entry, speciesOf(hits), hits.length);
    if (entry.sameAs) expect(speciesOf(hits)).toEqual(speciesOf(await galleryHits(page, entry.sameAs, false)));
  });
}

// Command-K asks the species list and the quick photo search; both groups are in the listbox.
for (const entry of QUERIES.filter((e) => e.surfaces.includes("palette"))) {
  test(`palette: ${entry.q}`, async ({ page }) => {
    await page.goto("/gallery");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox");
    await box.fill(entry.q);
    const text = await settledText(() => page.getByRole("listbox").innerText());
    // A species the palette lists has no photo hit in the same group; either counts as found.
    check(entry, namesIn(text));
    // Same rules as the Gallery: the quick photo hits never name a species the full search drops.
    const quick = speciesOf(await galleryHits(page, entry.q, true));
    for (const n of quick) expect(namesIn(text), `"${entry.q}" palette lists ${n}`).toContain(n);
  });
}

for (const entry of QUERIES.filter((e) => e.surfaces.includes("collection"))) {
  test(`collection filter: ${entry.q}`, async ({ page }) => {
    // The earlier projects downloaded Canada too, and a bare / with two countries shows the
    // first-run prompt, so open the golden library's country directly.
    await page.goto(SEED_COLLECTION);
    const search = page.getByLabel("Search species");
    // The page clears a search typed before its region settles, so wait for the cards first.
    await expect(page.getByText("Pileated Woodpecker").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await search.fill(entry.q);
    const shown = namesIn(await settledText(() => page.locator("main").innerText()));
    check(entry, shown);
    // One rule set: the Gallery finds the same species for the same words.
    const gallery = speciesOf(await galleryHits(page, entry.q, false));
    expect(shown, `"${entry.q}" collection and gallery agree`).toEqual(gallery);
  });
}

// Typing a word letter by letter only narrows the results, and never ends on nothing.
for (const { word, min } of golden.narrowing) {
  test(`prefixes only narrow: ${word}`, async ({ page }) => {
    let before: string[] | null = null;
    for (let n = min; n <= word.length; n++) {
      const sets = {
        full: speciesOf(await galleryHits(page, word.slice(0, n), false)),
        quick: speciesOf(await galleryHits(page, word.slice(0, n), true)),
      };
      for (const [surface, set] of Object.entries(sets)) {
        expect(set.length, `${surface} "${word.slice(0, n)}" is not empty`).toBeGreaterThan(0);
        if (before && surface === "quick")
          for (const s of set) expect(before, `"${word.slice(0, n)}" adds ${s}`).toContain(s);
      }
      before = sets.quick;
    }
  });
}

for (const [one, many] of golden.plurals) {
  test(`singular and plural agree: ${one}, ${many}`, async ({ page }) => {
    expect(speciesOf(await galleryHits(page, many, false))).toEqual(speciesOf(await galleryHits(page, one, false)));
  });
}
