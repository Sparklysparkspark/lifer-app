// F-02: several values in one filter (any of them) combined with another filter (all of them), and
// the whole set surviving a reload or a copied URL.
import { COUNTRY, PROVINCE, SECOND_PROVINCE, SPECIES } from "../support/fixtureCatalog.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { rate, seedTrip, setRegion, type SeededTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Multi-value Filters";

test.describe.configure({ mode: "serial" });
let trip: SeededTrip;
let filteredUrl: string;

test("filters to BC or Alberta, 3 to 5 stars", async ({ page }) => {
  // Only bc-4 and ab-3 are both in BC or Alberta and rated 3 to 5.
  const photos = [
    { file: "bc-4.jpg", region: PROVINCE.name, stars: 4 },
    { file: "ab-3.jpg", region: SECOND_PROVINCE.name, stars: 3 },
    { file: "ab-1.jpg", region: SECOND_PROVINCE.name, stars: 1 },
    { file: "ca-5.jpg", region: COUNTRY.name, stars: 5 },
  ];
  trip = await seedTrip(
    page.request,
    TRIP,
    photos.map((p, i) => ({
      file: p.file,
      species: SPECIES.moose,
      taken: `2022:08:0${i + 1} 14:17:00`,
      tint: 180 + i,
    })),
  );
  for (const p of photos) {
    await setRegion(page.request, trip.captureIds[p.file], p.region);
    await rate(page.request, trip.captureIds[p.file], p.stars);
  }

  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(4);

  await page.getByRole("button", { name: "Filters (1)" }).click();
  const regionSearch = page.getByRole("combobox", { name: "Search regions" });
  await regionSearch.fill("British");
  await page.getByRole("option", { name: new RegExp(PROVINCE.name) }).click();
  await regionSearch.fill("Alb");
  await page.getByRole("option", { name: new RegExp(SECOND_PROVINCE.name) }).click();
  await expect(page.getByRole("button", { name: `Remove filter: ${PROVINCE.name}, ${COUNTRY.name}` })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Remove filter: ${SECOND_PROVINCE.name}, ${COUNTRY.name}` }),
  ).toBeVisible();
  await expect(tiles).toHaveCount(3);

  const stars = page.getByRole("group", { name: "Rating", exact: true });
  await stars.getByRole("button", { name: "3 stars", exact: true }).click();
  await stars.getByRole("button", { name: "5 stars", exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(page).toHaveURL(/[?&]regionId=[^&]+&regionId=[^&]+/);
  filteredUrl = page.url();
});

test("a reload or a copied URL brings back BC or Alberta, 3 to 5 stars", async ({ page }) => {
  markKnownFailure(test.info());
  const tiles = page.getByTestId("photo-tile");
  for (const open of [() => page.goto(filteredUrl), () => page.reload()]) {
    await open();
    await expect(page.getByRole("button", { name: "Filters (3)" })).toBeVisible();
    await expect(tiles).toHaveCount(2);
  }
});
