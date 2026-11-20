// The companion app page (/apps/:id) in each state, with a faked desktop shell and app, into
// SCREENS_DIR/plugin. Runs only for `npm run screens -- --pages=plugin`.
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, seedSparse } from "../support/extremeLibrary.js";
import { HEADERS } from "../support/library.js";
import { THEMES } from "./pages.js";

const OUT = process.env.SCREENS_DIR ?? path.join("screens", "latest");
const wanted = process.env.SCREENS_PAGES?.split(",").includes("plugin");
test.skip(!wanted, "only with --pages=plugin");
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:50001";
const LONG = "A companion app with a very long name that keeps going well past any sensible label length";
const ICON = "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM15.5 13v7M13 16.5h7";

type Mode = "running" | "starting" | "stopped" | "closed" | "fresh";

function plugins(count: number, surface: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `com.example.app${i}`,
    name: `App ${i}`,
    page: {
      label:
        i === 0
          ? count > 3
            ? LONG
            : "Field Kit"
          : count > 3
            ? `Companion app ${i}`
            : ["Field Kit", "Notebook", "Tools"][i],
      icon: ICON,
      accent: ["#2f7d5b", "#b45309", "#1d4ed8"][i % 3],
      surface: i === 0 ? surface : "default",
    },
    scopes: [],
    approved: true,
  }));
}

async function shell(context: BrowserContext, mode: Mode, count: number, surface = "default") {
  await context.addInitScript(
    ({ mode, list, origin }) => {
      const endpoint = { origin, pageUrl: `${origin}/`, pageToken: "secret" };
      const win = window as unknown as Record<string, unknown>;
      win.__LIFER_PLATFORM__ = "darwin";
      win.__TAURI__ = {
        core: {
          invoke: async (cmd: string) => {
            if (cmd === "plugins_list") return list;
            if (cmd === "plugin_status") {
              if (mode === "running") return { state: "running", endpoint, error: null };
              if (mode === "starting") return { state: "starting", endpoint: null, error: null };
              const error = {
                stopped: "It stopped unexpectedly. Restart it to carry on.",
                closed: "Field Kit was closed.",
              }[mode as string];
              return { state: "stopped", endpoint: null, error: error ?? null };
            }
            if (cmd === "plugin_start") return new Promise(() => undefined);
            return null;
          },
        },
      };
    },
    { mode, list: plugins(count, surface), origin: ORIGIN },
  );
  // The e2e server is a multi-user one; the page needs it to say desktop, and to allow the frame.
  await context.route("**/api/settings", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, deploymentMode: "desktop" } });
  });
  await context.route(
    (url) => url.pathname === "/apps/" || url.pathname.startsWith("/apps/"),
    async (route) => {
      const res = await route.fetch();
      const headers = {
        ...res.headers(),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; connect-src * ipc:; frame-src http://127.0.0.1:*",
      };
      await route.fulfill({ response: res, headers });
    },
  );
}

async function fakeApp(context: BrowserContext, dark: boolean, answers = true) {
  await context.route(`${ORIGIN}/**`, (route) =>
    answers
      ? route.fulfill({
          contentType: "text/html",
          body: `<body style="margin:0;font:16px system-ui;background:${dark ? "#101214" : "#fbf7ee"};color:${dark ? "#e8e6e1" : "#222"}"><div style="padding:32px"><h1>Field Kit</h1><p>This page is served by the companion app itself.</p><div style="height:420px;border-radius:12px;background:${dark ? "#1c2024" : "#efe7d4"}"></div></div></body>`,
        })
      : new Promise(() => undefined),
  );
}

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

const SCENES: Array<{ name: string; mode: Mode; count: number; surface?: string; answers?: boolean; wait?: number }> = [
  { name: "running", mode: "running", count: 3 },
  { name: "dark-surface", mode: "running", count: 3, surface: "dark" },
  { name: "starting", mode: "starting", count: 3 },
  { name: "stopped", mode: "stopped", count: 3 },
  { name: "closed", mode: "closed", count: 3 },
  { name: "none", mode: "running", count: 0 },
  { name: "many-long", mode: "running", count: 10 },
  { name: "never-answers", mode: "running", count: 3, answers: false, wait: 21_000 },
];
const SIZES = [
  { width: 800, height: 600 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
];

for (const theme of THEMES) {
  for (const scene of SCENES) {
    for (const size of scene.name === "running" ? SIZES : SIZES.slice(0, 2)) {
      test(`${scene.name} ${theme} ${size.width}`, async ({ browser }) => {
        test.setTimeout(90_000);
        const context = await browser.newContext({ viewport: size, colorScheme: theme });
        await context.addInitScript((t) => localStorage.setItem("lifer-theme", t), theme);
        expect((await context.request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT })).ok()).toBe(
          true,
        );
        await shell(context, scene.mode, scene.count, scene.surface);
        await fakeApp(context, scene.surface === "dark" || theme === "dark", scene.answers);
        const page = await context.newPage();
        await page.goto("/apps/com.example.app0");
        await page.waitForTimeout(scene.wait ?? 1500);
        await page.screenshot({ path: path.join(OUT, "plugin", `${scene.name}-${theme}-${size.width}.png`) });
        await context.close();
      });
    }
  }
}
