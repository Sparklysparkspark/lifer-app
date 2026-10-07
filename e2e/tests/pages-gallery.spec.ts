// The Gallery beyond the plain listing (import.spec.ts covers that): the trip scope from the
// search palette, search and its ?q= in the URL, the keyboard shortcuts for selecting, bulk tags,
// bulk ID correction, ratings, featured photos, grouping, the lightbox and deleting.
// Runs after import.spec.ts: see pages-trip-detail.spec.ts.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Gallery";

test("searches, selects and edits photos in the Gallery", async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "chickadee.jpg", species: SPECIES.chickadee, taken: "2021:02:03 12:00:00", tint: 50 },
    { file: "moose-old.jpg", species: SPECIES.moose, taken: "2022:04:05 12:00:00", tint: 60 },
    { file: "moose-new.jpg", species: SPECIES.moose, taken: "2024:09:10 12:00:00", tint: 70 },
  ]);

  // Scoped to this spec's trip, the way the palette's "search this trip" opens it.
  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(page.getByText(`In trip ${TRIP}`)).toBeVisible();
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("3 photos", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();

  // Search by species name; the query goes into the URL.
  const search = page.getByLabel("Search your photos by what's in them");
  await search.fill("moose");
  await expect(page.getByText(/^2 photos matching "moose"/)).toBeVisible();
  await expect(tiles).toHaveCount(2);
  await expect(page).toHaveURL(/[?&]q=moose(&|$)/);
  await search.fill("");
  await expect(tiles).toHaveCount(3);
  await expect(page).not.toHaveURL(/[?&]q=/);

  // Keyboard: S enters select mode, mod+A selects every photo, Escape leaves.
  // The "Desktop Chrome" device reports Windows, so the app's "mod" key is Ctrl on any host.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("s");
  await expect(page.getByText("0 selected")).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(page.getByText("3 selected")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);

  // Bulk tag the two moose photos, then filter by that tag.
  await search.fill("moose");
  await expect(tiles).toHaveCount(2);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.keyboard.press("Control+a");
  await expect(page.getByText("2 selected")).toBeVisible();
  const tagInput = page.getByPlaceholder("Add a tag");
  const tagged = page.waitForResponse(
    (res) => res.url().endsWith("/api/captures/tags") && res.request().method() === "PATCH",
  );
  await tagInput.fill("e2e-gallery-tag");
  await tagInput.press("Enter");
  expect((await tagged).ok()).toBe(true);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);
  await search.fill("");
  await expect(tiles).toHaveCount(3);
  await page.getByRole("button", { name: "Filters (1)" }).click();
  const tagFilter = page.getByRole("combobox", { name: "Tag", exact: true });
  await tagFilter.selectOption("e2e-gallery-tag");
  await expect(tiles).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Filters (2)" })).toBeVisible();
  await tagFilter.selectOption("");
  await expect(tiles).toHaveCount(3);

  // Display options: ratings under each tile, and grouping by region.
  await page.getByRole("checkbox", { name: "Ratings" }).check();
  await page.getByRole("checkbox", { name: "Group by region" }).check();
  await expect(page.getByRole("heading", { level: 2, name: "Unknown region" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Group by region" }).uncheck();
  await page.locator("main").click({ position: { x: 5, y: 5 } });

  // Rate one photo 5 stars, then show only top rated.
  const rated = page.waitForResponse((res) => res.url().endsWith("/rating") && res.request().method() === "PATCH");
  await tiles.first().getByRole("button", { name: "Rate 5 stars" }).click();
  expect((await rated).ok()).toBe(true);
  await page.getByRole("button", { name: "Filters (1)" }).click();
  await page.getByRole("checkbox", { name: "Top rated" }).check();
  await expect(tiles).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Top rated" }).uncheck();
  await expect(tiles).toHaveCount(3);
  await page.locator("main").click({ position: { x: 5, y: 5 } });

  // The tile menu features a moose photo. The species may already have one of these featured
  // (whichever the import filed first), so this picks one that isn't. One photo per species is
  // featured, so "Featured" then shows exactly one of the two moose.
  const moose = tiles.filter({ has: page.getByRole("img", { name: SPECIES.moose.commonName }) });
  await moose.first().getByRole("button", { name: "More options" }).click();
  const firstLabel = await page.getByRole("button", { name: /^(Set as|Remove from) featured$/ }).textContent();
  await page.keyboard.press("Escape");
  // Newest first: moose.first() is the 2024 photo, moose.last() the 2022 one.
  const featuredNewest = firstLabel === "Set as featured";
  const target = featuredNewest ? moose.first() : moose.last();
  await target.getByRole("button", { name: "More options" }).click();
  const featured = page.waitForResponse((res) => res.url().endsWith("/cover") && res.request().method() === "PATCH");
  await page.getByRole("button", { name: "Set as featured" }).click();
  expect((await featured).ok()).toBe(true);
  await target.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("button", { name: "Remove from featured" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filters (1)" }).click();
  await page.getByRole("checkbox", { name: "Featured" }).check();
  await expect(tiles.getByRole("img", { name: SPECIES.moose.commonName })).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Featured" }).uncheck();
  await expect(tiles).toHaveCount(3);
  await page.locator("main").click({ position: { x: 5, y: 5 } });

  // The lightbox opens on a photo and closes.
  await tiles.first().getByRole("img").click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  // Correct the chickadee's ID to moose from the select bar.
  await search.fill("chickadee");
  await expect(tiles).toHaveCount(1);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("combobox", { name: "Type a species…" }).fill("moose");
  await page.getByRole("option", { name: new RegExp(SPECIES.moose.commonName) }).click();
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);
  // Checked on the plain listing: search answers can lag an edit by a few seconds (the API
  // caches its library stamp briefly).
  await search.fill("");
  await expect(tiles).toHaveCount(3);
  await expect(tiles.getByRole("img", { name: SPECIES.moose.commonName })).toHaveCount(3);

  // Delete one photo with the Delete key: the moose that isn't featured, since species cards on
  // later pages would otherwise ask for a trashed cover photo. Newest first, the tiles are the
  // 2024 moose, the 2022 moose, then the 2021 photo that was the chickadee.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles
    .nth(featuredNewest ? 1 : 0)
    .getByRole("checkbox", { name: "Select photo" })
    .check();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Delete");
  await expect(page.getByRole("heading", { name: "Delete 1 photo?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 photos", { exact: true })).toBeVisible();

  // Removing the trip scope drops it from the URL and the filter count.
  await page.getByRole("button", { name: `Remove filter: In trip ${TRIP}` }).click();
  await expect(page).not.toHaveURL(/tripId=/);
  await expect(page.getByText(`In trip ${TRIP}`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
});
