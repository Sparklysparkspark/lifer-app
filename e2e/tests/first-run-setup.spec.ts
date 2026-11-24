// The first-run setup screen's moving parts, with the server's progress scripted in the browser
// (the real packs apply too fast to watch): the species list load says "Loading…" and then a
// measured time left, the two progress rows, "Continue in the background", "You're all set" after
// the first pack, and the cancel and error paths. Nothing here changes the server's state.
import type { Page } from "@playwright/test";
import { COUNTRY, SPECIES } from "../support/fixtureCatalog.js";
import { expect, test } from "../support/test.js";

const MB = 1e6;
const BIRDS = `${COUNTRY.name} birds`;
const MAMMALS = `${COUNTRY.name} mammals`;
const TIME_LEFT = /^About \d+ (seconds?|minutes?) left$/;

const lane = (o: object = {}) => ({
  currentItem: null,
  processed: 0,
  total: 2,
  downloadedBytes: null,
  totalBytes: null,
  ...o,
});

function status(o: object = {}, lanes: object = {}) {
  return {
    running: true,
    phase: "downloading",
    downloadedBytes: null,
    totalBytes: null,
    processed: 0,
    total: 2,
    currentItem: null,
    error: null,
    finishedAt: null,
    cancelRequested: false,
    cancelled: false,
    result: null,
    packIds: ["canada-aves", "canada-mammalia"],
    currentPack: null,
    catalogProgress: null,
    lanes: { download: lane(), setup: { ...lane(), step: null }, photos: lane(), ...lanes },
    ...o,
  };
}

/** Two packs after a species list load: 0-4 s the list, 4-9 s birds download, 9-13 s mammals
 *  download while birds set up, then birds are in and mammals set up. */
function scripted(s: number, end: "cancelled" | "failed" | null) {
  if (end === "cancelled") return status({ running: false, finishedAt: Date.now(), cancelled: true });
  if (end === "failed")
    return status({ running: false, finishedAt: Date.now(), error: "Couldn't reach the download server." });
  if (s < 4) {
    const zero = { total: 0 };
    return status(
      { phase: "preparing", total: 0, catalogProgress: { processed: 2500 * s, total: 100_000 } },
      { download: lane(zero), setup: { ...lane(zero), step: null }, photos: lane(zero) },
    );
  }
  if (s < 9) {
    return status(
      {},
      { download: lane({ currentItem: BIRDS, downloadedBytes: ((s - 4) / 5) * 35 * MB, totalBytes: 35 * MB }) },
    );
  }
  if (s < 13) {
    return status(
      { phase: "applying" },
      {
        download: lane({
          currentItem: MAMMALS,
          processed: 1,
          downloadedBytes: ((s - 9) / 4) * 20 * MB,
          totalBytes: 20 * MB,
        }),
        setup: { ...lane({ currentItem: BIRDS }), step: "checklist" },
      },
    );
  }
  return status(
    { phase: "applying" },
    {
      download: lane({ processed: 2 }),
      setup: { ...lane({ currentItem: MAMMALS, processed: 1 }), step: "checklist" },
    },
  );
}

// A fresh install as far as setup knows: nothing downloaded (so it doesn't send the user on) and
// no earlier library in the folder (so nothing is chosen for them).
async function noPacksYet(page: Page) {
  await page.route("**/api/library/existing", (route) =>
    route.fulfill({ json: { found: false, regions: [], taxa: [] } }),
  );
  await page.route("**/api/offline-packs/index", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const p of body.packs) p.downloaded = false;
    await route.fulfill({ response: res, json: body });
  });
}

/** Scripts the pack download from the moment Download is clicked. `end` stops the run. */
async function scriptDownload(page: Page) {
  const run = { startedAt: null as number | null, end: null as "cancelled" | "failed" | null };
  await noPacksYet(page);
  await page.route("**/api/offline-packs/download/status", (route) =>
    route.fulfill({
      json: run.startedAt == null ? status({ running: false }) : scripted((Date.now() - run.startedAt) / 1000, run.end),
    }),
  );
  await page.route("**/api/offline-packs/download-batch", (route) => {
    run.startedAt = Date.now();
    return route.fulfill({ json: { started: true, packIds: ["canada-aves", "canada-mammalia"] } });
  });
  await page.route("**/api/offline-packs/download/cancel", (route) => {
    run.end = "cancelled";
    return route.fulfill({ json: { cancelled: true } });
  });
  return run;
}

async function startDownload(page: Page) {
  await page.goto("/onboarding");
  await page.getByPlaceholder("Search for a country…").fill(COUNTRY.name.slice(0, 4));
  await page.getByRole("button", { name: COUNTRY.name, exact: true }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add all" }).click();
  await page.getByRole("button", { name: "Download 1 country" }).click();
  await expect(page.getByRole("heading", { name: "Setting up your collection" })).toBeVisible();
}

test("the species list load says Loading, then a measured time left, then shows the countries", async ({ page }) => {
  const startedAt = Date.now();
  const loading = () => Date.now() - startedAt < 7000;
  await noPacksYet(page);
  // A fresh server: no countries yet, and the list loading at a steady pace.
  await page.route("**/api/regions", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (loading()) body.regions = body.regions.filter((r: { parentId: string | null }) => r.parentId === null);
    await route.fulfill({ response: res, json: body });
  });
  await page.route("**/api/settings", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (loading()) {
      body.catalogLoading = "running";
      body.catalogProgress = { processed: 4 * (Date.now() - startedAt), total: 120_000 };
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/onboarding");

  await expect(page.getByText("Getting the species list ready").first()).toBeVisible();
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  await expect(page.getByText(TIME_LEFT)).toBeVisible({ timeout: 6000 });
  // No fixed time is ever promised.
  await expect(page.getByText(/About 20 seconds\./)).toHaveCount(0);
  await expect(page.getByPlaceholder("Search for a country…")).toBeVisible({ timeout: 10_000 });
});

test("shows one progress bar, lets the user go on after the first pack, with Go to my collection first", async ({
  page,
}) => {
  await scriptDownload(page);
  await startDownload(page);

  // The species list first: its own row, timed once measured, and nothing to browse yet.
  await expect(page.getByText("Getting the species list ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue in the background" })).toHaveCount(0);
  await expect(page.getByText(TIME_LEFT)).toBeVisible({ timeout: 4000 });

  await expect(page.getByText("Downloading", { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(`${BIRDS}, 1 of 2`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue in the background" })).toBeVisible();
  // A pack set up while the next downloads is a note under the download, not a second bar.
  await expect(page.getByText(`Also setting up ${BIRDS} on this computer`)).toBeVisible({ timeout: 8000 });
  // Each tip links to its guide.
  await expect(page.getByRole("button", { name: "Read more in the guide" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible({ timeout: 10_000 });
  const collection = page.getByRole("button", { name: "Go to my collection" });
  const importFirst = page.getByRole("button", { name: "Import your first photos" });
  await expect(collection).toHaveAttribute("data-primary", "true");
  await expect(importFirst).toBeVisible();
  // Side by side, the collection first.
  const [a, b] = [await collection.boundingBox(), await importFirst.boundingBox()];
  expect(a!.x).toBeLessThan(b!.x);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(4);
  // The rest still shows its progress here.
  await expect(page.getByText(`${MAMMALS}. Doesn't use the internet`)).toBeVisible();

  await collection.click();
  await expect(page).toHaveURL(/\/\?region=/);
});

test("Continue in the background goes in before the first pack, with the progress following", async ({ page }) => {
  await scriptDownload(page);
  await startDownload(page);
  await page.getByRole("button", { name: "Continue in the background" }).click({ timeout: 8000 });
  await expect(page).toHaveURL(/\/\?region=/);
  await expect(page.getByText("Setting up on this computer").first()).toBeVisible({ timeout: 15_000 });
});

test("cancelling before the first pack goes back to the animal groups", async ({ page }) => {
  await scriptDownload(page);
  await startDownload(page);
  await expect(page.getByText(`${BIRDS}, 1 of 2`)).toBeVisible({ timeout: 8000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("menuitem", { name: "Stop everything" }).click();
  await expect(page.getByRole("heading", { name: "Which animals do you photograph?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download 1 country" })).toBeEnabled();
});

test("a download that fails before the first pack says why and offers it again", async ({ page }) => {
  const run = await scriptDownload(page);
  await startDownload(page);
  await expect(page.getByText(`${BIRDS}, 1 of 2`)).toBeVisible({ timeout: 8000 });
  run.end = "failed";
  await expect(page.getByText("The download didn't finish. Check your connection, then download again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download 1 country" })).toBeEnabled();
});

test("the Collection fills in as a background pack lands, without a reload", async ({ page }) => {
  // The Collection opens while the first pack is still setting up: its first answer is empty.
  let landed = false;
  await page.route("**/api/offline-packs/download/status", (route) =>
    route.fulfill({
      json: landed
        ? status({ running: false, finishedAt: Date.now() }, { setup: { ...lane({ processed: 2 }), step: null } })
        : status({ phase: "applying" }, { setup: { ...lane({ currentItem: BIRDS }), step: "checklist" } }),
    }),
  );
  await page.route(/\/api\/regions\/[^/]+\/species(\/count)?(\?|$)/, async (route) => {
    const res = await route.fetch();
    if (landed) return route.fulfill({ response: res });
    const body = await res.json();
    const empty = { total: 0, collected: 0, seen: 0 };
    await route.fulfill({ response: res, json: "items" in body ? { ...body, items: [], stats: empty } : empty });
  });
  await page.goto("/");
  await expect(page.getByText("0 of 0 photographed")).toBeVisible();
  await expect(page.getByText(SPECIES.chickadee.commonName)).toHaveCount(0);

  landed = true;
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("0 of 0 photographed")).toHaveCount(0);
});
