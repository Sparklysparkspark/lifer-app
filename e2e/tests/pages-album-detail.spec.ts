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

  // View menu: one column, so the grid's order is the page order. Newest first, then oldest taken first.
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("slider", { name: "Photo grid thumbnail size" }).fill("800");
  await expect(tiles.first().getByRole("img").first()).toHaveAccessibleName(SPECIES.moose.commonName);
  await page.getByLabel("Sort").selectOption("oldest");
  await expect(tiles.first().getByRole("img").first()).toHaveAccessibleName(SPECIES.chickadee.commonName);
  await expect(page.getByRole("button", { name: "View (1)" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Labels", exact: true }).check();
  await expect(page.locator("main").getByText(SPECIES.moose.commonName, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await tiles.first().getByRole("img").first().click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  // Filters, the Gallery's own: neither photo is rated, so 5 stars empties the grid and Unrated
  // keeps both. Birds is answered by the server and leaves the chickadee.
  await page.getByRole("button", { name: "Filters" }).click();
  await page
    .getByRole("group", { name: "Rating", exact: true })
    .getByRole("button", { name: "5 stars", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  await expect(tiles).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Unrated", exact: true }).check();
  await expect(tiles).toHaveCount(2);
  await page.getByRole("button", { name: "Clear rating" }).click();
  await page.getByRole("button", { name: "Birds", exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.getByRole("img", { name: SPECIES.chickadee.commonName })).toBeVisible();
  await page.getByRole("button", { name: "Clear animal filter" }).click();
  await expect(tiles).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Species view, from the View menu's Show switch: the Collection's toolbar, without Select.
  const viewMenu = page.getByRole("button", { name: /^View( \(\d\))?$/ });
  await viewMenu.click();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Species" }).click();
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText(SPECIES.chickadee.commonName).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Photos" }).click();
  await page.keyboard.press("Escape");
  await expect(tiles).toHaveCount(2);

  // The toolbar keeps the frequent controls; the rest are in the More menu.
  const more = page.locator("header").getByRole("button", { name: "More options" });
  await more.click();
  for (const item of ["Edit album", "Export", "Delete album"]) {
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  }
  await expect(page.getByRole("menuitem", { name: "Edit rules" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The tile menu sets the album cover (the first photo added is the cover until one is picked).
  await tiles.last().getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Use as album cover" }).click();
  await tiles.last().getByRole("button", { name: "More options" }).click();
  // Choosing it again would go back to the automatic cover.
  await expect(page.getByRole("menuitem", { name: "Album cover ✓" })).toBeEnabled();
  await page.keyboard.press("Escape");

  // Edit mode: the cover editor, then a quad cover with one tile's photo picked from the grid.
  await more.click();
  await page.getByRole("menuitem", { name: "Edit album" }).click();
  await expect(page.getByRole("link", { name: "Add photos" })).toHaveAttribute(
    "href",
    `/gallery?select=1&albumId=${albumId}`,
  );
  await expect(page.getByText("Hover the cover to adjust its crop.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Quad grid" }).click();
  await expect(page.getByText("Hover a tile to change its photo or crop.")).toBeVisible();
  await page.getByRole("button", { name: "Change" }).first().click({ force: true });
  await expect(page.getByText("Click a photo below to use it in this tile.")).toBeVisible();
  const slotSaved = page.waitForResponse((res) => res.url().endsWith(`/api/albums/${albumId}/quad-slot`));
  await tiles.last().getByRole("img").first().click();
  expect((await slotSaved).ok()).toBe(true);
  await expect(page.getByText("Hover a tile to change its photo or crop.")).toBeVisible();
  await page.getByRole("button", { name: "Done editing" }).click();
  await expect(page.getByRole("button", { name: "Quad grid" })).toHaveCount(0);

  // Share links: create one, then revoke it.
  await page.getByRole("button", { name: "Share…" }).click();
  // Exact locations are off unless the owner turns them on.
  await expect(page.getByRole("checkbox", { name: /Show exact locations/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Allow visitors to download photos" }).check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("No password, Downloads allowed")).toBeVisible();
  await expect(page.getByText(/\/share\/[^/]+$/)).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page
    .getByRole("dialog", { name: "Revoke this share link?" })
    .getByRole("button", { name: "Revoke link" })
    .click();
  // Revoked links leave the list, one click from coming back into view.
  await page.getByRole("button", { name: "Show 1 revoked or expired link" }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide sharing" }).click();

  // Select one photo and remove it from the album.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Remove from album" }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText("Removed 1 photo from the album"),
  ).toBeVisible();
  await expect(tiles).toHaveCount(1);
  await page.reload();
  await expect(tiles).toHaveCount(1);

  // "Add photos" opens the Gallery as a picker for this album; adding returns to the album.
  await more.click();
  await page.getByRole("menuitem", { name: "Edit album" }).click();
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

test("New album opens an empty album with its name selected to type over", async ({ page }) => {
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album" }).click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  const title = page.locator("header input").first();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue(/^Untitled Album/);
  await expect(page.getByRole("button", { name: "Add photos" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import into album" })).toBeVisible();

  // Typing replaces the selected name; Enter saves it.
  const saved = page.waitForResponse((res) => res.request().method() === "PATCH" && /\/api\/albums\//.test(res.url()));
  await page.keyboard.type("E2E Named In Place");
  await page.keyboard.press("Enter");
  expect((await saved).ok()).toBe(true);

  // A reload is a normal visit: the name isn't selected again.
  await page.reload();
  await expect(title).toHaveValue("E2E Named In Place");
  await expect(title).not.toBeFocused();

  // An empty unnamed album is kept, never cleaned up behind the user's back.
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album" }).click();
  await expect(title).toBeFocused();
  const untitled = await title.inputValue();
  await page.goto("/albums");
  await expect(page.getByText(untitled, { exact: true })).toBeVisible();
});
