// Photo versions by hand: a print scanned years later, under another species, found by searching
// in "Link to another photo", linked from the viewer's keys, then split out and back with Undo.
// The "Desktop Chrome" device reports Windows, so Mod is Ctrl on any host.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Photo Versions";
// Long on purpose: the picker and panel must wrap or truncate it, never overflow.
const PRINT = "moose-print-for-the-gallery-wall-at-the-lake-house-final-final-v3_16x20.jpg";

test("links a print from years later by search, then splits it out and undoes", async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "moose-original.jpg", species: SPECIES.moose, taken: "2020:06:01 06:17:00", tint: 231 },
    { file: PRINT, species: SPECIES.chickadee, taken: "2024:02:10 12:00:00", tint: 232 },
  ]);
  const notifications = page.getByRole("region", { name: "Notifications" });
  const tiles = page.getByTestId("photo-tile");

  await page.goto(`/gallery?tripId=${trip.id}`);
  await expect(tiles).toHaveCount(2);

  // Newest first: the print. Mod+G opens the picker, which explains the two-minute list.
  await tiles.first().getByRole("img").first().click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.keyboard.press("Control+g");
  const picker = page.getByRole("dialog", { name: "Link to another photo" });
  await expect(
    picker.getByText("No photos were taken within two minutes. Search to find any other photo."),
  ).toBeVisible();
  await picker.getByRole("textbox", { name: "Search photos" }).fill("moose-original");
  await picker.getByRole("button", { name: "Link to moose-original.jpg" }).click();
  await expect(notifications.getByText("Linked as a version")).toBeVisible();

  // The panel lists both files; the original's species counts, once.
  const panel = page.getByRole("dialog", { name: "Versions" });
  await expect(panel.getByText(PRINT)).toBeVisible();
  await expect(panel.getByText("moose-original.jpg")).toBeVisible();
  await panel.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first().getByText("2 versions")).toBeVisible();

  // In the viewer: switch to the print, use it as the photo, then split it out and undo.
  await tiles.first().getByRole("img").first().click();
  const strip = page.getByRole("radiogroup", { name: "Versions" });
  await expect(strip.getByRole("radio")).toHaveCount(2);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(strip.getByRole("radio", { checked: true })).toHaveText("Print 16x20");
  await page.keyboard.press("Shift+S");
  await expect(notifications.getByText("Showing Print 16x20")).toBeVisible();
  await expect(page.getByText("Shown as the photo")).toBeVisible();

  await page.keyboard.press("Control+Shift+g");
  await expect(notifications.getByText("Print 16x20 is a photo of its own again")).toBeVisible();
  await notifications.getByRole("button", { name: "Undo" }).last().click();
  await expect(strip.getByRole("radio")).toHaveCount(2);

  // Shift+G opens the panel for the photo on screen.
  await page.keyboard.press("Shift+G");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Link to another photo" })).toHaveCount(0);
});

test("a photo without versions explains linking, with a way to learn more", async ({ page }) => {
  const trip = await seedTrip(page.request, `${TRIP} Single`, [
    { file: "lonely-chickadee.jpg", species: SPECIES.chickadee, taken: "2021:04:01 08:00:00", tint: 233 },
  ]);
  await page.goto(`/gallery?tripId=${trip.id}`);
  await page.getByTestId("photo-tile").first().getByRole("img").first().click();
  await page.keyboard.press("Shift+G");
  const panel = page.getByRole("dialog", { name: "Versions" });
  await expect(panel.getByText("This photo has no other versions.")).toBeVisible();
  await expect(panel.getByText(/Link it to the photo it was made from/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "See how it works" })).toBeVisible();
  await panel.getByRole("button", { name: "Link to another photo" }).click();
  await expect(page.getByRole("dialog", { name: "Link to another photo" })).toBeVisible();
});
