// F-03: pin the current filters, apply the pin in one click, rename it, and find it again after
// the app starts afresh (pins live in the account, not the browser).
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, rate, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Pinned Filters";

test("pins, applies, renames and keeps a pinned filter", async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "top.jpg", species: SPECIES.chickadee, taken: "2021:03:01 14:17:00", tint: 184 },
    { file: "plain.jpg", species: SPECIES.chickadee, taken: "2021:03:02 14:17:00", tint: 185 },
  ]);
  await rate(page.request, trip.captureIds["top.jpg"], 5);

  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(2);
  await page.getByRole("button", { name: "Filters (1)" }).click();
  await page
    .getByRole("group", { name: "Rating", exact: true })
    .getByRole("button", { name: "5 stars", exact: true })
    .click();
  await expect(tiles).toHaveCount(1);
  await page.locator("main").click({ position: { x: 5, y: 5 } });

  // The toolbar's More menu is the header's last; pin chips and photo tiles have their own.
  await page.locator("header").getByRole("button", { name: "More options" }).last().click();
  await page.getByRole("menuitem", { name: "Pin these filters" }).click();
  const name = page.getByRole("textbox", { name: "Pin these filters" });
  await name.fill("E2E top chickadees");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Pinned.")).toBeVisible();

  const pins = page.getByRole("group", { name: "Pinned filters" });
  const pin = pins.getByRole("button", { name: "E2E top chickadees" });
  await expect(pin).toBeVisible();
  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(page).not.toHaveURL(/tripId=/);
  await expect.poll(() => tiles.count()).toBeGreaterThan(1);
  await pin.click();
  await expect(tiles).toHaveCount(1);
  await expect(pin).toHaveAttribute("aria-pressed", "true");

  // Rename in Manage pinned filters; a name saves when the field loses focus.
  await pins.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Manage pinned filters" }).click();
  // Other specs leave pins of their own, so pick this spec's field by its name.
  const fields = page.getByRole("textbox", { name: "Pinned filter name" });
  const values = await fields.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  const field = fields.nth(values.indexOf("E2E top chickadees"));
  await field.fill("E2E best chickadees");
  const saved = page.waitForResponse(
    (res) => res.url().endsWith("/api/pinned-filters") && res.request().method() === "PUT",
  );
  await field.press("Tab");
  expect((await saved).ok()).toBe(true);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(pins.getByRole("button", { name: "E2E best chickadees" })).toBeVisible();

  // A fresh start with nothing kept in the browser still has the pin.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/gallery");
  const renamed = page
    .getByRole("group", { name: "Pinned filters" })
    .getByRole("button", { name: "E2E best chickadees" });
  await expect(renamed).toBeVisible();
  await expect(page.getByRole("button", { name: "E2E top chickadees" })).toHaveCount(0);
  await renamed.click();
  await expect(tiles).toHaveCount(1);

  // Other specs expect no pins.
  expect((await page.request.put("/api/pinned-filters", { headers: HEADERS, data: { pins: [] } })).ok()).toBe(true);
});
