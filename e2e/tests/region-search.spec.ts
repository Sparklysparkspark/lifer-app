// F-08: region search knows other names: "Holland" finds the Netherlands.
import { ALIASED_COUNTRY, SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip, setRegion } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Region Search";

test('searching regions for "Holland" finds the Netherlands', async ({ page }) => {
  const trip = await seedTrip(page.request, TRIP, [
    { file: "dutch.jpg", species: SPECIES.robin, taken: "2019:04:01 14:17:00", tint: 194 },
  ]);
  // The Gallery's region filter offers only regions with photos.
  await setRegion(page.request, trip.captureIds["dutch.jpg"], ALIASED_COUNTRY.name);

  await page.goto("/gallery");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("combobox", { name: "Search regions" }).fill("Holland");
  const option = page.getByRole("option", { name: new RegExp(ALIASED_COUNTRY.name) });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(page.getByRole("button", { name: `Remove filter: ${ALIASED_COUNTRY.name}` })).toBeVisible();
  await expect(page.getByTestId("photo-tile")).toHaveCount(1);
});
