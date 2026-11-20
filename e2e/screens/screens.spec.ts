// Screenshots of every main page: each seed, theme and window size, into SCREENS_DIR.
import path from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, seedExtreme, seedSparse } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { PAGES, SEEDS, SIZES, THEMES } from "./pages.js";

const OUT = process.env.SCREENS_DIR ?? path.join("screens", "latest");
const pick = (name: string, all: readonly string[]) => {
  const want = process.env[name]?.split(",").filter(Boolean);
  return want?.length ? all.filter((x) => want.includes(x)) : all;
};
const pages = pick("SCREENS_PAGES", Object.keys(PAGES));
const seeds = pick("SCREENS_SEEDS", SEEDS);
const sizes = process.env.SCREENS_WIDTHS?.split(",").filter(Boolean).map(Number);

const BATCH = 4;

test.describe.configure({ mode: "serial" });

for (const seed of seeds) {
  test.describe(seed, () => {
    test.beforeAll(async () => {
      test.setTimeout(300_000);
      const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
      await db.connect();
      try {
        if (seed === "extreme") await seedExtreme(db);
        else await seedSparse(db, { items: seed === "sparse" ? 1 : 0 });
      } finally {
        await db.end();
      }
    });

    for (const theme of THEMES) {
      for (const size of SIZES.filter((s) => !sizes?.length || sizes.includes(s.width))) {
        test(`${theme} ${size.width}`, async ({ browser }) => {
          const context = await browser.newContext({ viewport: size, colorScheme: theme });
          await context.addInitScript((t) => localStorage.setItem("lifer-theme", t), theme);
          const res = await context.request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT });
          expect(res.ok()).toBe(true);
          // Pages open side by side: each one is mostly waiting on the network.
          const shoot = async (name: string) => {
            const page = await context.newPage();
            await page.goto(PAGES[name]);
            await page.locator("#root > *").first().waitFor({ state: "attached", timeout: 30_000 });
            // Pages that poll never go idle; a settled load is enough.
            await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(OUT, seed, `${name}-${theme}-${size.width}.png`) });
            await page.close();
          };
          for (let i = 0; i < pages.length; i += BATCH) await Promise.all(pages.slice(i, i + BATCH).map(shoot));
          await context.close();
        });
      }
    }
  });
}
