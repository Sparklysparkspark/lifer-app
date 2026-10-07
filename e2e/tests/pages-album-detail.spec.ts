// An album's page: the photo grid's sort, filters and lightbox, the species view, the description,
// the album cover (single and quad), share links, removing photos, and adding them back through
// the Gallery's album picker. Runs after import.spec.ts: see pages-trip-detail.spec.ts.
import { SPECIES } from "../support/fixtureCatalog.js";
import { createAlbum, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const ALBUM = "E2E Album Detail";

test("shows, edits, shares and refills an album", async ({ page }) => {
  const trip = await seedTrip(page.request, "E2E Album Source", [
    { file: "chickadee.jpg", species: SPECIES.chickadee, taken: "2022:03:04 12:00:00", tint: 30 },
    { file: "moose.jpg", species: SPECIES.moose, taken: "2024:08:09 12:00:00", tint: 40 },
  ]);
  // The moose goes in last, so it's first in the album's default order (newest added).
  const albumId = await createAlbum(page.request, ALBUM, [
    trip.captureIds["chickadee.jpg"],
    trip.captureIds["moose.jpg"],
  ]);

  await page.goto(`/albums/${albumId}`);
  await expect(page.locator("header input").first()).toHaveValue(ALBUM);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(2);

  // The description saves when the field loses focus.
  const description = page.getByPlaceholder("Add a description…");
  await description.fill("Birds and a moose");
  const saved = page.waitForResponse(
    (res) => res.url().endsWith(`/api/albums/${albumId}`) && res.request().method() === "PATCH",
  );
  await description.blur();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByPlaceholder("Add a description…")).toHaveValue("Birds and a moose");

  // One column, so the grid's order is the page order. Newest first, then oldest taken first.
  await page.getByRole("slider", { name: "Photo grid thumbnail size" }).fill("800");
  await expect(tiles.first().getByRole("img")).toHaveAccessibleName(SPECIES.moose.commonName);
  await page.getByLabel("Sort").selectOption("oldest");
  await expect(tiles.first().getByRole("img")).toHaveAccessibleName(SPECIES.chickadee.commonName);

  await tiles.first().getByRole("img").click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  // Filters: neither photo is rated, so "Top rated" empties the grid; Labels adds captions.
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByRole("checkbox", { name: "Top rated" }).check();
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  await expect(tiles).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Top rated" }).uncheck();
  await expect(tiles).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Labels" }).check();
  await expect(page.locator("main").getByText(SPECIES.moose.commonName, { exact: true })).toBeVisible();

  // Species view.
  await page.getByRole("button", { name: "Species view" }).click();
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(tiles).toHaveCount(2);

  // The tile menu sets the album cover (the first photo added is the cover until one is picked).
  await tiles.last().getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Set as album cover" }).click();
  await tiles.last().getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("button", { name: "Album cover ✓" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Edit mode: a quad cover, with one tile's photo picked from the grid.
  await page.getByRole("button", { name: "Edit album" }).click();
  await expect(page.getByRole("link", { name: "Add photos" })).toHaveAttribute(
    "href",
    `/gallery?select=1&albumId=${albumId}`,
  );
  await page.getByRole("button", { name: "Edit cover" }).click();
  await page.getByRole("button", { name: "Quad grid" }).click();
  await expect(page.getByText("Hover a tile to change its photo or crop.")).toBeVisible();
  await page.getByRole("button", { name: "Change" }).first().click({ force: true });
  await expect(page.getByText("Click a photo below to use it in this tile.")).toBeVisible();
  const slotSaved = page.waitForResponse((res) => res.url().endsWith(`/api/albums/${albumId}/quad-slot`));
  await tiles.last().getByRole("img").click();
  expect((await slotSaved).ok()).toBe(true);
  await expect(page.getByText("Hover a tile to change its photo or crop.")).toBeVisible();
  await page.getByRole("button", { name: "Done editing cover" }).click();
  await page.getByRole("button", { name: "Done editing" }).click();

  // Share links: create one, then revoke it.
  await page.getByRole("button", { name: "Share…" }).click();
  await page.getByRole("checkbox", { name: "Allow visitors to download photos" }).check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("No password · Downloads allowed")).toBeVisible();
  await expect(page.getByText(/\/share\/[^/]+$/)).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide sharing" }).click();

  // Select one photo and remove it from the album.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Remove from album" }).click();
  await expect(tiles).toHaveCount(1);
  await page.reload();
  await expect(tiles).toHaveCount(1);

  // "Add photos" opens the Gallery as a picker for this album; adding returns to the album.
  await page.getByRole("button", { name: "Edit album" }).click();
  await page.getByRole("link", { name: "Add photos" }).click();
  await expect(page.getByRole("heading", { name: `Add photos to ${ALBUM}` })).toBeVisible();
  // Narrowed to this spec's trip so the picker's "select all" takes only its photos.
  await page.goto(`/gallery?select=1&albumId=${albumId}&tripId=${trip.id}`);
  await expect(page.getByRole("heading", { name: `Add photos to ${ALBUM}` })).toBeVisible();
  await expect(tiles).toHaveCount(2);
  // The "Desktop Chrome" device reports Windows, so the app's "mod" key is Ctrl on any host.
  await page.keyboard.press("Control+a");
  await page.getByRole("button", { name: "Add 2 to album" }).click();
  await expect(page).toHaveURL(new RegExp(`/albums/${albumId}$`));
  await expect(tiles).toHaveCount(2);
});
