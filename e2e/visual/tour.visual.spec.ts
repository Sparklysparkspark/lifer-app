// The visual tour: the main screens of a realistic library, compared with checked-in screenshots.
// Every step also fails on console errors, page errors, error toasts and failed requests
// (visual.ts). See docs/docs/contributing/testing.md for reading a diff and approving baselines.
import type { Page } from "@playwright/test";
import { HEADERS, json } from "../support/library.js";
import { REAL_SPECIES } from "../support/realisticCatalog.js";
import { MARKS } from "../support/realisticLibrary.js";
import { CARD_SIZES, expect, regionId, setCardSize, settle, test } from "./visual.js";

const HEIGHT = 900;

/** Text that changes from run to run: temp folder paths, and dates of today's downloads and imports. */
function changing(page: Page) {
  return [page.getByText(/lifer-e2e-|\/var\/folders\/|\/tmp\//), page.getByText(/\b(today|ago|just now)\b/i)];
}

async function snap(page: Page, name: string): Promise<void> {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { mask: changing(page) });
}

const REGIONS = ["World", "North America", "Canada", "British Columbia", "Costa Rica"];

test.describe("collection", () => {
  for (const region of REGIONS) {
    for (const width of [1280, 2560]) {
      for (const [sizeName, size] of Object.entries(CARD_SIZES)) {
        test(`${region} at ${width}px, ${sizeName} cards`, async ({ page }) => {
          await page.setViewportSize({ width, height: HEIGHT });
          await setCardSize(page, size);
          await page.goto(`/?region=${await regionId(page, region)}`);
          await expect(page.getByRole("heading", { level: 1, name: region })).toBeVisible();
          await snap(page, `collection-${region.toLowerCase().replace(/\s+/g, "-")}-${width}-${sizeName}`);
        });
      }
    }
  }
});

test.describe("pages", () => {
  test.use({ viewport: { width: 1280, height: HEIGHT } });

  test("species page header", async ({ page }) => {
    // A photographed species with a card crop.
    const name = REAL_SPECIES[MARKS.cardCrops[0]].scientificName;
    const res = await json<{ results: Array<{ id: string; scientific_name: string }> }>(
      await page.request.get(`/api/species?q=${encodeURIComponent(name)}`, { headers: HEADERS }),
    );
    const id = res.results.find((r) => r.scientific_name === name)!.id;
    await page.goto(`/species/${id}?regionId=${await regionId(page, "Costa Rica")}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await snap(page, "species-header");
  });

  test("gallery", async ({ page }) => {
    await page.goto("/gallery");
    await snap(page, "gallery");
  });

  test("gallery search by name", async ({ page }) => {
    // Scene words ("heron in water") need image vectors the fixture doesn't have; names don't.
    await page.goto("/gallery");
    await page.getByLabel("Search your photos by what's in them").fill("Toucan");
    await expect(page.getByText("Searching…")).toHaveCount(0);
    await snap(page, "gallery-search-toucan");
  });

  test("downloaded regions", async ({ page }) => {
    await page.goto("/settings/species/downloads");
    await snap(page, "downloaded-regions");
  });

  test("albums", async ({ page }) => {
    await page.goto("/albums");
    await snap(page, "albums");
  });

  test("settings", async ({ page }) => {
    await page.goto("/settings");
    await snap(page, "settings");
  });

  test("import", async ({ page }) => {
    await page.goto("/import");
    await snap(page, "import");
  });
});
