// Companion apps, end to end, with the example app (e2e/fixtures/example-plugin): its page in Lifer,
// consent, the host protocol, an import, hiding, notices, revoking, and the suggested apps offer.
// The API runs in desktop mode (support/desktopServer.ts). The Tauri shell can't run in a browser,
// so a stub stands in for it: it reads the app's manifest and launches the app the way plugins.rs
// does. Discovery, approval, health polling and installer checks are tested in Rust.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Page } from "@playwright/test";
import { DESKTOP_URL, startDesktopApi, type DesktopApi } from "../support/desktopServer.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { makeCameraJpeg } from "../support/photo.js";
import { resetLibrary } from "../support/resetLibrary.js";
import { expect, test } from "../support/test.js";

const PLUGIN = path.resolve("e2e/fixtures/example-plugin/plugin.mjs");
const ID = "com.example.lifer-example";
const LAUNCH = randomBytes(32).toString("hex");
const SHELL = { "x-lifer-client": "1", "x-lifer-launch-token": LAUNCH };
// Keys that would mean catalog data reached an app (plan: data rules).
const CATALOG_KEY = /region|checklist|tier|rarity|season|weekly|reference|description|commonName/i;

interface Endpoint {
  origin: string;
  pageUrl: string;
  pageToken: string;
}

let dir = "";
let api: DesktopApi | null = null;
let app: ChildProcess | null = null;
let endpoint: Endpoint;
let summary: Record<string, unknown>;
let importFolder = "";

test.describe.configure({ mode: "serial" });
// Desktop mode has no sign-in: the stub shell hands the window its credential.
test.use({ baseURL: DESKTOP_URL, storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // The app reads the life list and photos, and earlier specs' photos have no files here.
  await resetLibrary();
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-e2e-plugins-"));
  api = await startDesktopApi(LAUNCH, dir);

  // The app registers itself as an installer would; the stub shell lists it as plugins_list does.
  const manifestDir = path.join(dir, "plugins");
  execFileSync(process.execPath, [PLUGIN, "--install", "--dir", manifestDir]);
  const manifest = JSON.parse(readFileSync(path.join(manifestDir, `${ID}.json`), "utf8"));
  summary = {
    id: manifest.id,
    name: manifest.name,
    page: manifest.page,
    scopes: manifest.scopes,
    capabilities: manifest.capabilities,
    approved: true,
  };

  importFolder = path.join(dir, "to-import");
  mkdirSync(importFolder, { recursive: true });
  await makeCameraJpeg(path.join(importFolder, "plugin-import.jpg"), { tint: 61 });

  // Launch as the shell does: a fresh ticket whose hash the API learns first.
  const ticket = randomBytes(32).toString("hex");
  const registered = await fetch(`${DESKTOP_URL}/api/plugins/v1/host-tickets/${ID}`, {
    method: "PUT",
    headers: { ...SHELL, "content-type": "application/json" },
    body: JSON.stringify({
      ticketHash: createHash("sha256").update(ticket).digest("hex"),
      name: manifest.name,
      scopes: manifest.scopes,
    }),
  });
  expect(registered.ok).toBe(true);
  app = spawn(process.execPath, [PLUGIN, "--lifer-host", "--protocol=1"], {
    env: {
      ...process.env,
      LIFER_HOST_TICKET: ticket,
      LIFER_WATCH_PARENT_PID: String(process.pid),
      LIFER_API_URL: DESKTOP_URL,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no READY line within 30 s")), 30_000);
    createInterface({ input: app!.stdout! }).on("line", (l) => {
      if (!l.startsWith("LIFER_PLUGIN_READY ")) return;
      clearTimeout(timer);
      resolve(l);
    });
  });
  const ready = /^LIFER_PLUGIN_READY port=(\d+) page=(\/\S*) pageToken=([A-Za-z0-9._~-]{1,512})$/.exec(line);
  expect(ready, line).not.toBeNull();
  const origin = `http://127.0.0.1:${ready![1]}`;
  endpoint = { origin, pageUrl: `${origin}${ready![2]}`, pageToken: ready![3] };

  // The health challenge only the launched process can answer.
  const nonce = randomBytes(32).toString("hex");
  const health = await fetch(`${origin}/lifer-host/health?nonce=${nonce}`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ proof: createHmac("sha256", ticket).update(nonce).digest("hex") });
});

test.afterAll(async () => {
  // Closing stdin is how Lifer tells an app it is quitting.
  app?.stdin?.end();
  await api?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The desktop shell, as far as these pages need it.
async function stubShell(page: Page) {
  await page.addInitScript(
    ({ summary, endpoint, launch, folder }) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: string[] = [];
      w.__shellCalls = calls;
      w.__LIFER_PLATFORM__ = "linux";
      const answers: Record<string, () => unknown> = {
        local_api_credential: () => launch,
        plugins_list: () => [summary],
        plugin_start: () => endpoint,
        plugin_status: () => ({ state: "running", endpoint, error: null }),
        "plugin:dialog|open": () => folder,
        local_inference_status: () => ({ state: "off" }),
      };
      const invoke = async (cmd: string) => {
        calls.push(cmd);
        return answers[cmd]?.() ?? null;
      };
      let callbacks = 0;
      w.__TAURI__ = { core: { invoke } };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = {
        invoke,
        transformCallback: () => ++callbacks,
        metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      };
    },
    { summary, endpoint, launch: LAUNCH, folder: importFolder },
  );
}

test.beforeEach(async ({ page }) => {
  await stubShell(page);
});

const appLink = (page: Page) => page.getByRole("navigation").getByRole("link", { name: "Example", exact: true });
const appFrame = (page: Page) => page.frameLocator(`iframe[src^="${endpoint.origin}"]`);
const connectedApps = (page: Page) => page.goto("/settings/integrations");

async function openApp(page: Page) {
  await appLink(page).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${ID}$`));
}

test("consent pairs the app, and its page opens from the sidebar", async ({ page }) => {
  await page.goto("/gallery");

  // The app asks to pair as soon as it starts; Lifer asks the user once, over any page.
  const consent = page.getByRole("dialog", { name: "Allow Example companion to connect to Lifer?" });
  await expect(consent).toBeVisible();
  await expect(consent.getByText("Read your life list, targets and seen species, and your own photos")).toBeVisible();
  await expect(consent.getByText("Import photos into your library")).toBeVisible();
  await consent.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(consent).toBeHidden();

  await openApp(page);
  await expect(appFrame(page).getByRole("status").first()).toHaveText("Connected. 0 species in your life list.");
  await page.screenshot({ path: test.info().outputPath("plugin-page.png") });
});

test("the app reads the user's marks through its key, and nothing from the catalog", async ({ page, request }) => {
  const found = await (
    await request.get(`/api/species?q=${encodeURIComponent(SPECIES.chickadee.scientificName)}`, { headers: SHELL })
  ).json();
  const chickadee = found.results.find(
    (s: { scientific_name: string }) => s.scientific_name === SPECIES.chickadee.scientificName,
  );
  expect((await request.patch(`/api/species/${chickadee.id}/seen`, { headers: SHELL })).ok()).toBe(true);

  await page.goto(`/apps/${ID}`);
  await appFrame(page).getByRole("button", { name: "Refresh" }).click();
  await expect(appFrame(page).getByRole("status").first()).toHaveText("Connected. 1 species in your life list.");

  // What the app got back, read through its own page token.
  const state = await (
    await fetch(`${endpoint.origin}/state`, { headers: { "x-page-token": endpoint.pageToken } })
  ).json();
  expect(state.sample.scientificName).toBe(SPECIES.chickadee.scientificName);
  expect(Object.keys(state.sample).filter((k) => CATALOG_KEY.test(k))).toEqual([]);
});

test("the page opens Lifer's pages and hands over Lifer's shortcuts", async ({ page }) => {
  await page.goto(`/apps/${ID}`);
  const frame = appFrame(page);
  await frame.getByRole("button", { name: "Search the gallery" }).click();
  await expect(page).toHaveURL(/\/gallery\?q=chickadee$/);

  await page.goBack();
  await frame.getByRole("button", { name: "Open Black-capped Chickadee" }).click();
  await expect(page).toHaveURL(/\/species\/[0-9a-f-]+$/);

  await page.goBack();
  // Ctrl+1 (the stub shell says Linux) pressed inside the app's page opens Collection.
  await frame.getByRole("button", { name: "Refresh" }).focus();
  await page.keyboard.press("Control+1");
  await expect(page).not.toHaveURL(/\/apps\//);
});

test("the app imports a folder the user picked", async ({ page }) => {
  await page.goto(`/apps/${ID}`);
  await appFrame(page).getByRole("button", { name: "Import a folder" }).click();
  await expect(appFrame(page).getByText(/^Import finished: \d+ processed$/)).toBeVisible({ timeout: 30_000 });
  await expect(appFrame(page).getByText("Import finished: 0 processed")).toHaveCount(0);
});

test("notices follow the app's setting in Connected apps", async ({ page }) => {
  await page.goto(`/apps/${ID}`);
  await appFrame(page).getByRole("button", { name: "Send a notice" }).click();
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Hello from the example");

  await connectedApps(page);
  await page.getByRole("switch", { name: "Notices from Example companion" }).click();
  await openApp(page);
  await appFrame(page).getByRole("button", { name: "Send a notice" }).click();
  await expect(appFrame(page).getByText("Lifer said not-allowed")).toBeVisible();
});

test("hiding takes the app out of the sidebar, and Connected apps brings it back", async ({ page }) => {
  await page.goto("/gallery");
  await appLink(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide Example" }).click();
  await expect(appLink(page)).toHaveCount(0);

  await connectedApps(page);
  const show = page.getByRole("switch", { name: "Show Example companion in the sidebar" });
  await expect(show).toHaveAttribute("aria-checked", "false");
  await show.click();
  await expect(appLink(page)).toBeVisible();
});

test("revoking in Connected apps ends the app's access", async ({ page }) => {
  await connectedApps(page);
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No apps are connected")).toBeVisible();

  await openApp(page);
  await appFrame(page).getByRole("button", { name: "Refresh" }).click();
  await expect(appFrame(page).getByRole("status").first()).toHaveText(/^Not connected: Lifer answered 401/);
});

test("suggested apps request nothing before Install, and Show suggested apps off hides them", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    // The update check is answered by the test fixture and isn't about suggestions.
    if (host !== "127.0.0.1" && host !== "api.github.com") outside.push(r.url());
  });
  await page.goto("/gallery");
  const offer = page.getByRole("navigation").getByRole("link", { name: "Cull", exact: true });
  await offer.click();
  await expect(page).toHaveURL(/\/apps\/offer\/app\.preen\.desktop$/);
  await expect(page.getByRole("heading", { name: "Preen" })).toBeVisible();
  expect(outside).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __shellCalls: string[] }).__shellCalls)).not.toContain(
    "plugin_install",
  );

  await connectedApps(page);
  await page.getByRole("switch", { name: "Show suggested apps" }).click();
  await expect(offer).toHaveCount(0);
  await page.goto("/apps/offer/app.preen.desktop");
  await expect(page.getByText("This suggestion isn't available")).toBeVisible();
  expect(outside).toEqual([]);
});
