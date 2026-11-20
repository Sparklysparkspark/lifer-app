// The dialog a companion app's request to connect opens in the desktop app, with a faked shell
// and request, into SCREENS_DIR/pairing. Runs only for `npm run screens -- --pages=pairing`.
import path from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, seedSparse } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { THEMES } from "./pages.js";

const OUT = process.env.SCREENS_DIR ?? path.join("screens", "latest");
const wanted = process.env.SCREENS_PAGES?.split(",").includes("pairing");
test.skip(!wanted, "only with --pages=pairing");
test.describe.configure({ mode: "serial" });

const ALL = ["userdata.read", "userdata.write", "imports.write", "opendata.read"];
const LONG = `Companion ${"app with a very long name ".repeat(8)}`.slice(0, 200);
const UNSPACED = "N".repeat(200);

const SCENES = [
  {
    name: "launched",
    consent: { name: "Field Kit", scopes: ["userdata.read", "imports.write"], code: null },
    wait: 1500,
  },
  { name: "just-opened", consent: { name: "Field Kit", scopes: ["userdata.read"], code: null }, wait: 300 },
  { name: "code", consent: { name: "Field Kit", scopes: ALL, code: "482913" }, wait: 1500 },
  { name: "long-name", consent: { name: LONG, scopes: ALL, code: "000417" }, wait: 1500 },
  { name: "unspaced-name", consent: { name: UNSPACED, scopes: ALL, code: null }, wait: 1500 },
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
        });
        expect((await context.request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT })).ok()).toBe(
          true,
        );
        const consent = {
          id: "a".repeat(64),
          pluginId: "com.example.fieldkit",
          expiresAt: new Date().toISOString(),
          ...scene.consent,
        };
        // The e2e server is a multi-user one; the dialog only asks on the desktop.
        await context.route("**/api/settings", async (route) => {
          const res = await route.fetch();
          await route.fulfill({ response: res, json: { ...(await res.json()), deploymentMode: "desktop" } });
        });
        await context.route("**/api/plugins/v1/consents", (route) => route.fulfill({ json: { consents: [consent] } }));
        const page = await context.newPage();
        await page.goto("/");
        await page.getByRole("dialog").waitFor();
        await page.waitForTimeout(scene.wait);
        await page.screenshot({ path: path.join(OUT, "pairing", `${scene.name}-${theme}-${size.width}.png`) });
        await context.close();
      });
    }
  }
}
