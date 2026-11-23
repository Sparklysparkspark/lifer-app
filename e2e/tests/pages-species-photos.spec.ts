// The photo grid on a species page: ratings and the best-shot badge, sorting, caption choices, the
// lightbox, the tile menu (featured photo, tags, place name), select mode with bulk tags and ID
// correction, and deleting. It starts from an empty library, so the page holds exactly the photos
// made here.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip, speciesId } from "../support/library.js";
import { resetLibrary } from "../support/resetLibrary.js";
import { expect, test } from "../support/test.js";

test.beforeAll(() => resetLibrary());

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

  // View menu: one column, so the grid's order is the page order. Newest first by default.
  const viewMenu = page.getByRole("button", { name: /^View( \(\d\))?$/ });
  await viewMenu.click();
  await page.getByRole("slider", { name: "Photo grid thumbnail size" }).fill("800");
  await page.getByRole("checkbox", { name: "Labels" }).check();
  await expect(tiles.first()).toContainText("Nov 20, 2024");
  await page.getByLabel("Sort").selectOption("oldest");
  await expect(tiles.first()).toContainText("Jan 15, 2020");
  // Labels and Ratings are the same caption choices the Gallery offers, off until turned on.
  await page.getByRole("checkbox", { name: "Ratings" }).check();

  await page.keyboard.press("Escape");

  // Rating the older photo makes it the best shot, and first when sorted by rating.
  const rated = page.waitForResponse((res) => res.url().endsWith("/rating") && res.request().method() === "PATCH");
  await tiles.first().getByRole("button", { name: "Rate 4 stars" }).click();
  expect((await rated).ok()).toBe(true);
  await expect(tiles.first().getByText("Best shot")).toBeVisible();
  await viewMenu.click();
  await page.getByLabel("Sort").selectOption("rating");
  await expect(tiles.first()).toContainText("Jan 15, 2020");
  await page.getByLabel("Sort").selectOption("newest");
  await expect(tiles.first()).toContainText("Nov 20, 2024");

  // Labels (here the date and place) and Ratings hide their captions.
  const labels = page.getByRole("checkbox", { name: "Labels" });
  const ratings = page.getByRole("checkbox", { name: "Ratings" });
  await labels.uncheck();
  await ratings.uncheck();
  await expect(tiles.getByRole("button", { name: "Rate 1 star" })).toHaveCount(0);
  await expect(tiles.first()).not.toContainText("Nov 20, 2024");
  await labels.check();
  await ratings.check();
  await expect(tiles.getByRole("button", { name: "Rate 1 star" })).toHaveCount(2);
  await page.keyboard.press("Escape");

  // The lightbox, captioned with the photo's date.
  await tiles.first().locator("img").first().click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);

  // The tile menu: featured photo, tags and a place name.
  const menuButton = tiles.first().getByRole("button", { name: "More options" });
  await menuButton.click();
  const featured = await page.getByRole("menuitem", { name: /^(Set as|Remove as) featured photo$/ }).textContent();
  if (featured === "Set as featured photo") {
    const saved = page.waitForResponse((res) => res.url().endsWith("/cover") && res.request().method() === "PATCH");
    await page.getByRole("menuitem", { name: "Set as featured photo" }).click();
    expect((await saved).ok()).toBe(true);
    // The menu reads the cover from the page's reload after the save, so reopen until it lands.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await menuButton.click();
      await expect(page.getByRole("menuitem", { name: "Remove as featured photo" })).toBeVisible({
        timeout: 1000,
      });
    }).toPass();
  }
  await expect(page.getByRole("menuitem", { name: "Remove as featured photo" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Edit tags" }).click();
  const tagged = page.waitForResponse((res) => res.url().endsWith("/tags") && res.request().method() === "PATCH");
  await page.getByPlaceholder("Add a tag").fill("e2e-species-tag");
  await page.getByPlaceholder("Add a tag").press("Enter");
  expect((await tagged).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Remove tag e2e-species-tag" })).toBeVisible();
  await page.getByRole("dialog", { name: "Tags" }).getByRole("button", { name: "Done" }).click();

  await menuButton.click();
  // One Location item: the coordinates dialog, with the place name and region behind a link.
  await page.getByRole("menuitem", { name: /^Location/ }).click();
  const placed = page.waitForResponse(
    (res) => res.url().endsWith("/api/captures/coordinates") && res.request().method() === "POST",
  );
  const dialog = page.getByRole("dialog", { name: /coordinates/ });
  await dialog.getByRole("button", { name: "Edit name and region" }).click();
  await dialog.getByLabel("Place name").fill("Backyard feeder");
  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await placed).ok()).toBe(true);
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
  await page.getByRole("menuitem", { name: "Delete photo" }).click();
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
