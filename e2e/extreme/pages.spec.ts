// Opens the main pages on the extreme, sparse and empty seeds (support/extremeLibrary.ts).
// The same spec runs in each of the three projects; the project name picks the seed.
import path from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, SEED_COLLECTION, seedExtreme, seedSparse } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";

const PAGES = [SEED_COLLECTION, "/gallery", "/albums", "/stats"];

// Once per project: the specs only read, so every test can share one seed.
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

for (const route of PAGES) {
  test(`${route} opens`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    const name = `${info.project.name}${route === SEED_COLLECTION ? "-collection" : route.replace("/", "-")}.png`;
    await page.screenshot({ path: path.join(process.env.CLAUDE_JOB_DIR ?? "test-results", "tmp", name) });
    expect(errors).toEqual([]);
  });
}
