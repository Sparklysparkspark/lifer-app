// Journey (T-02): delete a photo, find it in the Trash, restore it, and come back to the Gallery
// where it started (ux-rules F3, N1, N6).
import { SPECIES } from "../../support/fixtureCatalog.js";
import { HEADERS, json, seedTrip } from "../../support/library.js";
import { expect, test } from "../../support/test.js";

const TRIP = "E2E Journey Trash";

test("delete, find in the Trash, restore, and back to the Gallery", async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "keep.jpg", species: SPECIES.robin, taken: "2020:03:01 12:00:00", tint: 180 },
    { file: "bin.jpg", species: SPECIES.robin, taken: "2020:03:02 12:00:00", tint: 181 },
  ]);
  const binId = trip.captureIds["bin.jpg"];
  const scoped = `/gallery?tripId=${trip.id}`;
  const tiles = page.getByTestId("photo-tile");

  await page.goto(scoped);
  await expect(tiles).toHaveCount(2);
  // Newest first: the photo taken second is the first tile.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  // Instant, since the Trash keeps it: the toast says where it went.
  await page.keyboard.press("Delete");
  await expect(page.getByRole("region", { name: "Notifications" }).getByText("Moved to Trash")).toBeVisible();
  await expect(tiles).toHaveCount(1);

  // The Trash holds it, with its days left.
  const trash = await json<{ items: Array<{ captureId: string; photoId: string | null }> }>(
    await page.request.get("/api/trash", { headers: HEADERS }),
  );
  const binned = trash.items.find((i) => i.captureId === binId);
  expect(binned, "the deleted photo is in the Trash").toBeTruthy();
  await page.goto("/trash");
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
  const tile = tiles.filter({ has: page.locator(`img[src*="${binned!.photoId}"]`) });
  await expect(tile).toHaveCount(1);

  // Restore from its menu: it leaves the Trash at once.
  await tile.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(tile).toHaveCount(0);

  // Back returns to the Gallery as it was left, now with both photos.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`tripId=${trip.id}`));
  await expect(page.getByText(`In trip ${TRIP}`)).toBeVisible();
  await expect(tiles).toHaveCount(2);
});
