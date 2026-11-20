// Journey (T-02): import a photo, correct its identification, then undo, and the photo and its
// species are back as they were (ux-rules F3, N6).
import { SPECIES } from "../../support/fixtureCatalog.js";
import { markKnownFailure } from "../../support/knownFailures.js";
import { seedTrip } from "../../support/library.js";
import { expect, test } from "../../support/test.js";

test.beforeEach(() => markKnownFailure(test.info()));

test("correct an identification, then undo it", async ({ page }) => {
  const trip = await seedTrip(page.request, "E2E Journey Identify", [
    { file: "bird.jpg", species: SPECIES.chickadee, taken: "2018:05:01 12:00:00", tint: 183 },
  ]);
  const tiles = page.getByTestId("photo-tile");
  await page.goto(`/gallery?tripId=${trip.id}`);
  await expect(tiles.getByRole("img", { name: SPECIES.chickadee.commonName })).toHaveCount(1);

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles.first().getByRole("checkbox", { name: "Select photo" }).check();
  await page.getByRole("button", { name: "Correct ID" }).click();
  await page.getByRole("combobox", { name: "Type a species…" }).fill("robin");
  await page.getByRole("option", { name: new RegExp(SPECIES.robin.commonName) }).click();
  await expect(tiles.getByRole("img", { name: SPECIES.robin.commonName })).toHaveCount(1);

  // The change is offered back at once.
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).click();
  await expect(tiles.getByRole("img", { name: SPECIES.chickadee.commonName })).toHaveCount(1);
});
