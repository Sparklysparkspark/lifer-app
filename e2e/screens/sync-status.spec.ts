// Settings > Server's Sync rows in the desktop app's own library, with a faked shell and sync
// status: nothing waiting, and a first move of a large library (120,000 waiting) mid-send, into
// SCREENS_DIR/sync. Runs only for `npm run screens -- --pages=sync`.
import path from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, seedSparse } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { THEMES } from "./pages.js";

const OUT = process.env.SCREENS_DIR ?? path.join("screens", "latest");
const wanted = process.env.SCREENS_PAGES?.split(",").includes("sync");
test.skip(!wanted, "only with --pages=sync");
test.describe.configure({ mode: "serial" });

const idle = { running: false, error: null, result: null, finishedAt: null, processed: null, total: null };
const done = (result: object) => ({ ...idle, finishedAt: Date.parse("2026-11-03T18:30:00Z"), result });
const base = {
  linked: true,
  serverUrl: "https://lifer.example.com",
  serverChanged: false,
  derivative: "thumb",
  packs: idle,
};
const SCENES = [
  {
    name: "nothing-waiting",
    status: {
      ...base,
      unpushed: 0,
      waiting: { photos: 0, albums: 0, trips: 0 },
      push: done({ pushed: 12, uploaded: 3, failed: 0, conflicts: 0, library: 4 }),
      mirror: done({ applied: 15, userSpecies: 2, library: 4 }),
    },
  },
  {
    name: "120000-waiting",
    status: {
      ...base,
      unpushed: 120_000,
      waiting: { photos: 118_450, albums: 1_200, trips: 350 },
      push: { ...idle, running: true, processed: 1_500, total: 118_450 },
      mirror: done({ applied: 0, userSpecies: 0, library: 0 }),
    },
  },
];
const SIZES = [
  { width: 800, height: 600 },
  { width: 2560, height: 1440 },
];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    await seedSparse(db, { items: 1 });
  } finally {
    await db.end();
  }
});

for (const theme of THEMES) {
  for (const scene of SCENES) {
    for (const size of SIZES) {
      test(`${scene.name} ${theme} ${size.width}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: size, colorScheme: theme });
        await context.addInitScript((t) => localStorage.setItem("lifer-theme", t), theme);
        await context.addInitScript(() => {
          const win = window as unknown as Record<string, unknown>;
          win.__LIFER_PLATFORM__ = "darwin";
          win.__TAURI__ = { core: { invoke: async () => null } };
          // The app's own library, linked to a server.
          win.liferSetup = { getConfig: async () => ({ mode: "local" }) };
        });
        expect((await context.request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT })).ok()).toBe(true);
        await context.route("**/api/settings", async (route) => {
          const res = await route.fetch();
          await route.fulfill({ response: res, json: { ...(await res.json()), deploymentMode: "desktop" } });
        });
        await context.route("**/api/sync/status", (route) => route.fulfill({ json: scene.status }));
        const page = await context.newPage();
        await page.goto("/settings/server");
        const group = page.getByText("Albums and trips", { exact: true });
        await group.waitFor();
        await group.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, "sync", `${scene.name}-${theme}-${size.width}.png`) });
        await context.close();
      });
    }
  }
}
