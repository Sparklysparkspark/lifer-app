// Representative dialogs on the extreme seed (300-character names, 1,000 albums), each theme and
// window size, into SCREENS_DIR/modals. Runs only for `npm run screens -- --pages=modals`.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, seedExtreme } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { THEMES } from "./pages.js";

const OUT = path.join(process.env.SCREENS_DIR ?? path.join("screens", "latest"), "modals");
const wanted = process.env.SCREENS_PAGES?.split(",").includes("modals");
test.skip(!wanted, "only with --pages=modals");
test.describe.configure({ mode: "serial" });

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name }).first().click({ timeout: 5_000 });

const SCENES: Array<{ name: string; path: string; open: (page: Page) => Promise<unknown> }> = [
  { name: "confirm-empty-trash", path: "/trash", open: (p) => button(p, "Empty trash") },
  { name: "add-saved-spot", path: "/places", open: (p) => button(p, "Add spot") },
  { name: "smart-album", path: "/albums", open: (p) => button(p, "New smart album") },
  { name: "search-inaturalist", path: "/settings/species", open: (p) => button(p, /^Search$/) },
  { name: "shortcuts", path: "/gallery", open: (p) => p.keyboard.press("Shift+Slash") },
  { name: "command-palette", path: "/gallery", open: (p) => p.keyboard.press("Control+k") },
  { name: "connect-phone", path: "/settings/integrations", open: (p) => button(p, "Connect a phone") },
];
const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    await seedExtreme(db);
  } finally {
    await db.end();
  }
});

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`${theme} ${size.width}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: size, colorScheme: theme });
      await context.addInitScript((t) => localStorage.setItem("lifer-theme", t), theme);
      expect((await context.request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT })).ok()).toBe(
        true,
      );
      const only = process.env.SCREENS_SCENES?.split(",");
      for (const scene of SCENES.filter((s) => !only || only.includes(s.name))) {
        const page = await context.newPage();
        await page.goto(scene.path);
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        // A scene whose trigger isn't on this seed or width is skipped, not failed.
        const opened = await scene
          .open(page)
          .then(() => page.locator("[data-modal]").last().waitFor({ timeout: 5_000 }))
          .then(() => true)
          .catch((e: Error) => (console.log(`${scene.name}: ${e.message.split("\n")[0]}`), false));
        if (opened) {
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, `${scene.name}-${theme}-${size.width}.png`) });
        } else console.log(`skipped ${scene.name} ${theme} ${size.width}`);
        await page.close();
      }
      await context.close();
    });
  }
}
