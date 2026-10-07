// A trip's page: scanning its folder, assigning species in the review, importing, then the photo
// grid's search, sort, filters, species view, featured photo, select-and-delete and renaming.
//
// The pages-* specs run after import.spec.ts (files run in name order), whose exact counts they
// would otherwise change. Each one makes its own photos (support/library.ts).
import type { Page } from "@playwright/test";
import { SPECIES } from "../support/fixtureCatalog.js";
import { createTrip, writeTripFolder } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Trip Detail";

async function pickSpecies(page: Page, file: string, query: string, name: string): Promise<void> {
  const row = page.locator(`[data-import-row="${file}"]`);
  const picker = row.getByRole("combobox", { name: "Type a species…" });
  if (!(await picker.isVisible())) await row.getByRole("button", { name: "Type a species…" }).click();
  await picker.fill(query);
  await page.getByRole("option", { name: new RegExp(name) }).click();
}

test("scans, imports and manages a trip's photos", async ({ page }) => {
  const folder = await writeTripFolder(page.request, "trip-detail", [
    { file: "chickadee.jpg", species: SPECIES.chickadee, taken: "2023:06:01 12:00:00", tint: 10 },
    { file: "moose.jpg", species: SPECIES.moose, taken: "2024:07:02 12:00:00", tint: 20 },
  ]);
  const tripId = await createTrip(page.request, TRIP, folder);

  await page.goto(`/trips/${tripId}`);
  await expect(page.getByText("Nothing imported yet")).toBeVisible();
  // The API stores the folder's real path, which can differ from `folder` by a symlink.
  await expect(page.getByText(/\/e2e-trips\/trip-detail$/)).toBeVisible();
  await expect(page.getByText("· 0 photos")).toBeVisible();

  // The scan lists both files for review; each gets a species, then they import together.
  await page.getByRole("button", { name: "Add more photos" }).first().click();
  await expect(page.getByText("2 new photos · 0 ready to import")).toBeVisible();
  await pickSpecies(page, "chickadee.jpg", "chickadee", SPECIES.chickadee.commonName);
  await pickSpecies(page, "moose.jpg", "moose", SPECIES.moose.commonName);
  await expect(page.getByText("2 new photos · 2 ready to import")).toBeVisible();
  await page.getByRole("button", { name: "Import 2 photos" }).click();

  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText("· 2 photos")).toBeVisible();
  await expect(page.getByText(/^\s*2\s*species$/)).toBeVisible();

  // One column, so the grid's order is the page order.
  await page.getByRole("slider", { name: "Photo grid thumbnail size" }).fill("800");

  // Search narrows the grid by species name.
  const search = page.getByPlaceholder("Search this trip's species…");
  await search.fill("moose");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.getByRole("img", { name: SPECIES.moose.commonName })).toBeVisible();
  await search.fill("");
  await expect(tiles).toHaveCount(2);

  // Newest first by default; oldest first puts the 2023 chickadee on top.
  await expect(tiles.first().getByRole("img")).toHaveAccessibleName(SPECIES.moose.commonName);
  await page.getByLabel("Sort").selectOption("oldest");
  await expect(tiles.first().getByRole("img")).toHaveAccessibleName(SPECIES.chickadee.commonName);

  // The lightbox opens on the tile clicked, with its caption, and closes.
  await tiles.first().getByRole("img").click();
  await expect(page.getByText(`${SPECIES.chickadee.commonName} · Jun 1, 2023`)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText(`${SPECIES.chickadee.commonName} · Jun 1, 2023`)).toHaveCount(0);

  // Filters: neither photo is rated, so "Top rated" empties the grid.
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("checkbox", { name: "Top rated" }).check();
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  await expect(tiles).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Top rated" }).uncheck();
  await expect(tiles).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Labels" }).check();
  await expect(page.locator("main").getByText(SPECIES.moose.commonName, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Species view lists the trip's species as cards.
  await page.getByRole("button", { name: "Species view" }).click();
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible();
  await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(tiles).toHaveCount(2);

  // Featuring a photo opens the crop editor; afterwards the menu shows it as featured.
  await tiles.first().getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Set as featured photo" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await tiles.first().getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("button", { name: "Featured photo ✓" })).toBeVisible();
  await page.keyboard.press("Escape");

  const coverStyle = page.waitForResponse(
    (res) => res.url().endsWith(`/api/trips/${tripId}`) && res.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Quad grid" }).click();
  expect((await coverStyle).ok()).toBe(true);

  // Select one photo and delete it.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByText("0 selected")).toBeVisible();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("heading", { name: "Delete 1 photo?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(page.getByText("· 1 photo")).toBeVisible();
  await expect(tiles.getByRole("img", { name: SPECIES.moose.commonName })).toBeVisible();

  // The name saves on Enter and survives a reload.
  const title = page.locator("header input").first();
  await title.fill(`${TRIP} renamed`);
  await title.press("Enter");
  await expect(title).toHaveValue(`${TRIP} renamed`);
  await page.reload();
  await expect(page.locator("header input").first()).toHaveValue(`${TRIP} renamed`);
});
