// Shared by the sweep specs that run on the extreme, sparse and empty seeds: seeding once per
// project, signing in, and the page list.
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "./constants.js";
import { EXTREME_ACCOUNT, SEED_COLLECTION, seedExtreme, seedSparse } from "./extremeLibrary.js";
import { HEADERS } from "./library.js";

export const SWEEP_PAGES = [SEED_COLLECTION, "/gallery", "/albums", "/stats", "/settings"];

/** Seeds the library named by the running project. Call once from a top-level beforeAll. */
export function seedForProject(): void {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
    await db.connect();
    try {
      const seed = test.info().project.name;
      if (seed === "extreme") await seedExtreme(db);
      else await seedSparse(db, { items: seed === "sparse" ? 1 : 0 });
    } finally {
      await db.end();
    }
  });
  test.beforeEach(async ({ page }) => {
    const res = await page.context().request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT });
    expect(res.ok()).toBe(true);
  });
}

/** Visible text with the sidebar's own words included; scripts and styles are not text. */
export const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);
