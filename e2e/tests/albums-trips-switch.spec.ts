// The Albums page's Albums | Trips switch: one side at a time, in the address, remembered on reload,
// each side with its own search, sort and actions.
import { SPECIES } from "../support/fixtureCatalog.js";
import { createAlbum, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Switch Trip";
const ALBUM = "E2E Switch Album";

test("switches between albums and trips and remembers the side", async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "switch-a.jpg", species: SPECIES.chickadee, taken: "2018:02:03 08:31:00", tint: 220 },
    { file: "switch-b.jpg", species: SPECIES.moose, taken: "2018:02:03 09:47:00", tint: 221 },
  ]);
  await createAlbum(page.request, ALBUM, [trip.captureIds["switch-a.jpg"]]);

  await page.goto("/albums?view=albums");
  await expect(page.getByText(ALBUM, { exact: true })).toBeVisible();
  await expect(page.getByText(TRIP, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New album" })).toBeVisible();

  // Search on the albums side, then switch: the trips side starts unfiltered with its own actions.
  await page.getByLabel("Search albums by name").fill("no such album");
  await expect(page.getByText(ALBUM, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page).toHaveURL(/\/albums\?view=trips$/);
  await expect(page.getByText(TRIP, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Search trips by name")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start a trip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New album" })).toHaveCount(0);

  // Sort is the side's own; a changed sort shows on the View button.
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByLabel("Sort").selectOption("title");
  await expect(page.getByRole("button", { name: "View (1)" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The plain address opens the side seen last.
  await page.goto("/albums");
  await expect(page.getByText(TRIP, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Trips", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(page.getByRole("button", { name: "View", exact: true })).toBeVisible();
});
