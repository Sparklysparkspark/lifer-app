// The photo grid on a species page: ratings and the best-shot badge, sorting, gallery view, the
// lightbox, the tile menu (featured photo, tags, place name), select mode with bulk tags and ID
// correction, and deleting. Runs after import.spec.ts: see pages-trip-detail.spec.ts. Only this
// spec gives the robin photos, so the page holds exactly the photos made here.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip, speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

test("rates, sorts, edits and deletes photos on a species page", async ({ page }) => {
  await seedTrip(page.request, "E2E Species Photos", [
    { file: "robin-old.jpg", species: SPECIES.robin, taken: "2020:01:15 12:00:00", tint: 80 },
    { file: "robin-new.jpg", species: SPECIES.robin, taken: "2024:11:20 12:00:00", tint: 90 },
  ]);
  const robinId = await speciesId(page.request, SPECIES.robin);

  await page.goto(`/species/${robinId}`);
  await expect(page.getByRole("heading", { name: "Your photos" })).toBeVisible();
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(2);

  // One column, so the grid's order is the page order. Newest first by default.
  await page.getByRole("slider", { name: "Photo grid thumbnail size" }).fill("800");
  await expect(tiles.first()).toContainText("Nov 20, 2024");
  await page.getByLabel("Sort").selectOption("oldest");
  await expect(tiles.first()).toContainText("Jan 15, 2020");

  // Rating the older photo makes it the best shot, and first when sorted by rating.
  const rated = page.waitForResponse((res) => res.url().endsWith("/rating") && res.request().method() === "PATCH");
  await tiles.first().getByRole("button", { name: "Rate 4 stars" }).click();
  expect((await rated).ok()).toBe(true);
  await expect(tiles.first().getByText("Best shot")).toBeVisible();
  await page.getByLabel("Sort").selectOption("rating");
  await expect(tiles.first()).toContainText("Jan 15, 2020");
  await page.getByLabel("Sort").selectOption("newest");
  await expect(tiles.first()).toContainText("Nov 20, 2024");

  // Gallery view hides the captions and ratings.
  await page.getByRole("button", { name: "Gallery view" }).click();
  await expect(page.getByRole("button", { name: "Gallery view ✓" })).toBeVisible();
  await expect(tiles.getByRole("button", { name: "Rate 1 star" })).toHaveCount(0);
  await expect(tiles.first()).not.toContainText("Nov 20, 2024");
  await page.getByRole("button", { name: "Gallery view ✓" }).click();
  await expect(tiles.getByRole("button", { name: "Rate 1 star" })).toHaveCount(2);

  // The lightbox, captioned with the photo's date.
  await tiles.first().locator("img").first().click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  // The tile menu: featured photo, tags and a place name.
  const menuButton = tiles.first().getByRole("button", { name: "More options" });
  await menuButton.click();
  const featured = await page.getByRole("button", { name: /^(Set as featured photo|Featured photo ✓)$/ }).textContent();
  if (featured === "Set as featured photo") {
    const saved = page.waitForResponse((res) => res.url().endsWith("/cover") && res.request().method() === "PATCH");
    await page.getByRole("button", { name: "Set as featured photo" }).click();
    expect((await saved).ok()).toBe(true);
    // The menu reads the cover from the page's reload after the save, so reopen until it lands.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await menuButton.click();
      await expect(page.getByRole("button", { name: "Featured photo ✓" })).toBeVisible({ timeout: 1000 });
    }).toPass();
  }
  await expect(page.getByRole("button", { name: "Featured photo ✓" })).toBeVisible();

  await page.getByRole("button", { name: "Edit tags…" }).click();
  const tagged = page.waitForResponse((res) => res.url().endsWith("/tags") && res.request().method() === "PATCH");
  await page.getByPlaceholder("Add a tag").fill("e2e-species-tag");
  await page.getByPlaceholder("Add a tag").press("Enter");
  expect((await tagged).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Remove tag e2e-species-tag" })).toBeVisible();

  await page.getByRole("button", { name: "Set location…" }).click();
  const placed = page.waitForResponse((res) => res.url().endsWith("/region") && res.request().method() === "PATCH");
  await page.getByPlaceholder("Custom place name (e.g. Prince George)…").fill("Backyard feeder");
  await page.getByPlaceholder("Custom place name (e.g. Prince George)…").press("Enter");
  expect((await placed).ok()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(tiles.first()).toContainText("Backyard feeder");

  // Select mode: bulk tag both photos.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByText("0 selected")).toBeVisible();
  // Through each tile's own checkbox, which the "Best shot" badge must not cover: Playwright
  // refuses a click another element would intercept.
  await expect(tiles.getByText("Best shot")).toHaveCount(1);
  for (const tile of await tiles.all()) await tile.getByRole("checkbox", { name: "Select photo" }).check();
  await expect(page.getByText("2 selected")).toBeVisible();
  const bulkTagged = page.waitForResponse(
    (res) => res.url().endsWith("/api/captures/tags") && res.request().method() === "PATCH",
  );
  await page.getByPlaceholder("Add a tag").fill("e2e-species-bulk");
  await page.getByPlaceholder("Add a tag").press("Enter");
  expect((await bulkTagged).ok()).toBe(true);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);

  // Deleting from the select bar can be cancelled.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().locator("img").first().click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("heading", { name: "Delete 1 photo?" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Delete 1 photo?" })).toHaveCount(0);
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(tiles).toHaveCount(2);

  // Delete the photo that isn't featured from its menu (species cards on later pages would
  // otherwise ask for a trashed cover photo).
  await tiles.last().getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Delete photo" }).click();
  await expect(page.getByRole("heading", { name: "Delete 1 photo?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tiles).toHaveCount(1);

  // Correcting the last photo's ID moves it off this species.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().locator("img").first().click();
  await page.getByRole("combobox", { name: "Type a species…" }).fill("chickadee");
  await page.getByRole("option", { name: new RegExp(SPECIES.chickadee.commonName) }).click();
  await expect(page.getByText("Not photographed yet")).toBeVisible();
  await expect(tiles).toHaveCount(0);
});
