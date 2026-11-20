// Lightroom Classic import (I-04): a fixture catalogue built here is read into a preview grouped by
// kind, applied with one group switched off, then undone. Desktop only, so it runs against the
// desktop-mode API (support/desktopServer.ts) with a stub shell answering the file picker.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";
import { DESKTOP_URL, startDesktopApi, type DesktopApi } from "../support/desktopServer.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS, createTrip, json, speciesId, waitForJob } from "../support/library.js";
import { makeCameraJpeg } from "../support/photo.js";
import { expect, test } from "../support/test.js";

const LAUNCH = randomBytes(32).toString("hex");
const SHELL = { ...HEADERS, "x-lifer-launch-token": LAUNCH };
const TAKEN = { exif: "2017:04:12 08:00:00", lightroom: "2017-04-12T08:00:00" };
const COLLECTION = "E2E LR Pond";
const KEYWORD = "E2E Lightroom heron";

// The tables and columns Lightroom Classic 12 and 13 share, as catalog.integration.test.ts builds them.
const SCHEMA = `
  CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY, absolutePath TEXT, name TEXT);
  CREATE TABLE AgLibraryFolder (id_local INTEGER PRIMARY KEY, pathFromRoot TEXT, rootFolder INTEGER);
  CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY, baseName TEXT, extension TEXT, folder INTEGER);
  CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY, rating REAL, pick REAL, colorLabels TEXT,
    captureTime TEXT, rootFile INTEGER, masterImage INTEGER);
  CREATE TABLE AgHarvestedExifMetadata (id_local INTEGER PRIMARY KEY, image INTEGER, gpsLatitude REAL, gpsLongitude REAL);
  CREATE TABLE AgLibraryIPTC (id_local INTEGER PRIMARY KEY, image INTEGER, caption TEXT);
  CREATE TABLE AgLibraryKeyword (id_local INTEGER PRIMARY KEY, name TEXT, parent INTEGER);
  CREATE TABLE AgLibraryKeywordImage (id_local INTEGER PRIMARY KEY, image INTEGER, tag INTEGER);
  CREATE TABLE AgLibraryCollection (id_local INTEGER PRIMARY KEY, name TEXT, parent INTEGER, creationId TEXT);
  CREATE TABLE AgLibraryCollectionContent (id_local INTEGER PRIMARY KEY, collection INTEGER, content TEXT, owningModule TEXT);
  CREATE TABLE AgLibraryCollectionImage (id_local INTEGER PRIMARY KEY, collection INTEGER, image INTEGER);
`;

/** One photo Lifer has (rated 4, picked, keyworded, in a collection) and one it hasn't. */
function buildCatalogue(file: string, photo: string): void {
  const lr = new DatabaseSync(file);
  lr.exec(SCHEMA);
  const ext = path.extname(photo);
  lr.prepare("INSERT INTO AgLibraryRootFolder VALUES (1, ?, 'photos')").run(path.dirname(photo) + path.sep);
  lr.exec(`
    INSERT INTO AgLibraryFolder VALUES (1, '', 1);
    INSERT INTO AgLibraryFile VALUES (2, 'IMG_9999', 'CR3', 1);
    INSERT INTO Adobe_images VALUES (1, 4, 1, NULL, '${TAKEN.lightroom}', 1, NULL), (2, 2, 0, NULL, '${TAKEN.lightroom}', 2, NULL);
    INSERT INTO AgLibraryKeyword VALUES (1, '${KEYWORD}', NULL);
    INSERT INTO AgLibraryKeywordImage VALUES (1, 1, 1);
    INSERT INTO AgLibraryCollection VALUES (1, '${COLLECTION}', NULL, 'com.adobe.ag.library.collection');
    INSERT INTO AgLibraryCollectionImage VALUES (1, 1, 1), (2, 1, 2);
  `);
  lr.prepare("INSERT INTO AgLibraryFile VALUES (1, ?, ?, 1)").run(path.basename(photo, ext), ext.slice(1));
  lr.close();
}

let dir = "";
let api: DesktopApi | null = null;
let shell: APIRequestContext;
let captureId = "";
let tripId = "";
let catalogue = "";

test.describe.configure({ mode: "serial" });
test.use({ baseURL: DESKTOP_URL });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-e2e-lightroom-"));
  api = await startDesktopApi(LAUNCH, dir);
  shell = await playwrightRequest.newContext({ baseURL: DESKTOP_URL, extraHTTPHeaders: SHELL });

  // The heron is imported the way a trip folder is, then the catalogue points at the file Lifer holds.
  const folder = path.join(api.dataDir, "e2e-lightroom");
  mkdirSync(folder, { recursive: true });
  await makeCameraJpeg(path.join(folder, "lr-heron.jpg"), { taken: TAKEN.exif, tint: 165 });
  tripId = await createTrip(shell, "E2E Lightroom", folder);
  await json(await shell.post(`/api/trips/${tripId}/scan`));
  await waitForJob(shell, `/api/trips/${tripId}/scan/status`);
  const files = [{ relativePath: "lr-heron.jpg", speciesId: await speciesId(shell, SPECIES.robin) }];
  await json(await shell.post(`/api/trips/${tripId}/import`, { data: { files } }));
  await waitForJob(shell, `/api/trips/${tripId}/import/status`);
  const item = await galleryItem();
  captureId = item.captureId;
  catalogue = path.join(dir, "Lightroom Catalog.lrcat");
  buildCatalogue(catalogue, item.originalRef!);
});

test.afterAll(async () => {
  await shell?.dispose();
  await api?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function galleryItem() {
  const res = await json<{
    items: Array<{ captureId: string; originalRef: string | null; qualityRating: number | null; tags: string[] }>;
  }>(await shell.get(`/api/gallery?tripId=${tripId}`));
  expect(res.items).toHaveLength(1);
  return res.items[0];
}
async function albumNames(): Promise<string[]> {
  const res = await json<{ albums: Array<{ name: string }> }>(await shell.get("/api/albums"));
  return res.albums.map((a) => a.name);
}

// The desktop shell, as far as these pages need it: the session secret and the file picker.
async function stubShell(page: Page) {
  await page.addInitScript(
    ({ launch, catalogue }) => {
      const w = window as unknown as Record<string, unknown>;
      const answers: Record<string, () => unknown> = {
        local_api_credential: () => launch,
        "plugin:dialog|open": () => catalogue,
        local_inference_status: () => ({ state: "off" }),
        plugins_list: () => [],
      };
      const invoke = async (cmd: string) => answers[cmd]?.() ?? null;
      let callbacks = 0;
      w.__TAURI__ = { core: { invoke } };
      w.__TAURI_INTERNALS__ = {
        invoke,
        transformCallback: () => ++callbacks,
        metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      };
      // Event listeners unsubscribe through this when a page unmounts.
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    },
    { launch: LAUNCH, catalogue },
  );
}

test.beforeEach(async ({ page }) => {
  markKnownFailure(test.info());
  await stubShell(page);
});

test("previews a catalogue by kind, applies it in the background and undoes it", async ({ page }) => {
  expect((await galleryItem()).qualityRating).toBeNull();

  await page.goto("/import");
  await page.getByRole("link", { name: "Import a catalogue" }).click();
  await expect(page).toHaveURL(/\/import\/lightroom$/);
  await expect(page.getByRole("heading", { level: 1, name: "Lightroom Classic catalogue" })).toBeVisible();
  await page.getByRole("button", { name: "Choose catalogue" }).click();

  await expect(page.getByText("2 photos in the catalogue, 1 already in Lifer")).toBeVisible();
  await expect(page.getByText("1 photo isn't in Lifer yet.")).toBeVisible();
  const ratings = page.getByRole("switch", { name: "Star ratings" });
  const keywords = page.getByRole("switch", { name: "Keywords as tags" });
  const albums = page.getByRole("switch", { name: "Collections as albums" });
  for (const s of [ratings, keywords, albums]) await expect(s).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(COLLECTION)).toBeVisible();

  // Keywords stay behind; everything else comes over.
  await keywords.click();
  await expect(keywords).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Import changes" }).click();
  await expect(page.getByText(/^Updated 1 photo and added 1 album\.$/)).toBeVisible({ timeout: 30_000 });

  const applied = await galleryItem();
  expect(applied.captureId).toBe(captureId);
  expect(applied.qualityRating).toBe(4);
  expect(applied.tags).not.toContain(KEYWORD);
  expect(await albumNames()).toContain(COLLECTION);

  // One undo takes the whole import back.
  await page.getByRole("button", { name: /^Undo import/ }).click();
  await expect(page.getByText("The import was undone.")).toBeVisible();
  expect((await galleryItem()).qualityRating).toBeNull();
  expect(await albumNames()).not.toContain(COLLECTION);
});

test("onboarding offers a Lightroom Classic catalogue", async ({ page }) => {
  await page.goto("/onboarding");
  const entry = /Lightroom Classic catalogue/;
  await expect(page.getByRole("button", { name: entry }).or(page.getByRole("link", { name: entry }))).toBeVisible();
});
