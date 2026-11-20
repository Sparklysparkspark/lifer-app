// Pack downloads and removals are long actions: they must show a busy state at once, close their
// dialog, let the user go elsewhere, and update where the item lives (ux-rules F1, F2, F4, F5, P6).
// The server call is held back by a few seconds so the in-between state can be observed.
import type { APIRequestContext, Page } from "@playwright/test";
import { COUNTRY } from "../support/fixtureCatalog.js";
import { HEADERS } from "../support/library.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { expect, test } from "../support/test.js";

const HOLD_MS = 4000;
const PACK_IDS = ["aves", "mammalia", "amphibia"].map((t) => `${COUNTRY.name.toLowerCase()}-${t}`);

async function holdRequests(page: Page, urlPart: string): Promise<{ finished: () => boolean }> {
  let done = false;
  await page.route(`**/api/offline-packs/${urlPart}`, async (route) => {
    await new Promise((r) => setTimeout(r, HOLD_MS));
    await route.continue();
    done = true;
  });
  return { finished: () => done };
}

async function waitForNoDownload(request: APIRequestContext) {
  await expect
    .poll(async () => (await (await request.get("/api/offline-packs/download/status")).json()).running, {
      timeout: 30_000,
    })
    .toBe(false);
}

async function downloadAll(request: APIRequestContext) {
  await request.post("/api/offline-packs/download-batch", {
    headers: HEADERS,
    data: { regionNames: [COUNTRY.name], taxa: "all" },
  });
  await waitForNoDownload(request);
}

// One pack only: with none left, the first download sends the page on to the Collection
// (OfflinePacksPage), and these tests watch the list in place.
async function removeOne(request: APIRequestContext) {
  await request.post("/api/offline-packs/offload-batch", { headers: HEADERS, data: { packIds: [PACK_IDS[0]] } });
  // A download asked for while a removal runs is refused.
  await expect
    .poll(async () => (await (await request.get("/api/offline-packs/removal-status")).json()).running, {
      timeout: 30_000,
    })
    .toBe(false);
}

test.beforeEach(() => markKnownFailure(test.info()));

test.describe("removing a pack", () => {
  // Later specs need the country's packs, so every test hands them back.
  test.afterEach(async ({ request }) => downloadAll(request));

  async function startRemoval(page: Page) {
    const held = await holdRequests(page, "offload-batch");
    await page.goto("/settings/species/downloads");
    await page.getByRole("button", { name: new RegExp(`^${COUNTRY.name}`) }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Remove", exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    return { held, dialog };
  }

  test("the confirm dialog closes at once", async ({ page }) => {
    const { dialog } = await startRemoval(page);
    await expect(dialog).toBeHidden({ timeout: 500 });
  });

  test("the pack's row shows it is being removed", async ({ page }) => {
    await startRemoval(page);
    await expect(page.getByRole("listitem").filter({ hasText: /Removing/ })).toBeVisible({ timeout: 100 });
  });

  test("another page opens while the removal runs", async ({ page }) => {
    const { held } = await startRemoval(page);
    await page.getByRole("navigation").getByRole("link", { name: "Gallery", exact: true }).click({ timeout: 3000 });
    await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible({ timeout: 1000 });
    expect(held.finished(), "the page only opened once the removal had finished").toBe(false);
  });

  test("the list updates when the removal finishes, without navigating", async ({ page }) => {
    await startRemoval(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${COUNTRY.name} \\(2 regions\\)`) })).toBeVisible({
      timeout: HOLD_MS + 5000,
    });
  });
});

test.describe("downloading a pack", () => {
  test.beforeEach(async ({ request }) => removeOne(request));
  test.afterEach(async ({ request }) => downloadAll(request));

  async function startDownload(page: Page) {
    const held = await holdRequests(page, "download-batch");
    await page.goto("/settings/species/downloads");
    await page.getByRole("button", { name: "North America" }).click();
    await page.getByRole("button", { name: COUNTRY.name, exact: true }).click();
    // The removed pack's group: none is chosen for you.
    await page.getByRole("button", { name: "Birds", exact: true }).click();
    await page.getByRole("button", { name: "Download selected" }).click();
    return held;
  }

  test("the download button shows it has started", async ({ page }) => {
    await startDownload(page);
    await expect(page.getByRole("button", { name: /Starting/ })).toBeVisible({ timeout: 100 });
  });

  test("another page opens while the download starts", async ({ page }) => {
    const held = await startDownload(page);
    await page.getByRole("navigation").getByRole("link", { name: "Gallery", exact: true }).click({ timeout: 3000 });
    await expect(page.getByRole("heading", { level: 1, name: "Gallery" })).toBeVisible({ timeout: 1000 });
    expect(held.finished()).toBe(false);
  });

  test("the downloaded list updates when the download finishes, without navigating", async ({ page }) => {
    await startDownload(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${COUNTRY.name} \\(3 regions\\)`) })).toBeVisible({
      timeout: HOLD_MS + 15_000,
    });
  });
});
