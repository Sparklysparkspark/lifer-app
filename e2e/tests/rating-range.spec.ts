// U-03: the star range picker filters the Gallery to "3 to 5 stars".
import { SPECIES } from "../support/fixtureCatalog.js";
import { rate, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Rating Range";

test("filters the Gallery to 3 to 5 stars", async ({ page }) => {
  const ratings = { "two.jpg": 2, "three.jpg": 3, "five.jpg": 5, "unrated.jpg": null };
  const trip = await seedTrip(
    page.request,
    TRIP,
    Object.keys(ratings).map((file, i) => ({
      file,
      species: SPECIES.moose,
      taken: `2022:07:0${i + 1} 14:17:00`,
      tint: 176 + i,
    })),
  );
  for (const [file, stars] of Object.entries(ratings)) await rate(page.request, trip.captureIds[file], stars);

  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(4);

  await page.getByRole("button", { name: "Filters (1)" }).click();
  const stars = page.getByRole("group", { name: "Rating", exact: true });
  // One star, then a second, picks the range between them.
  await stars.getByRole("button", { name: "3 stars", exact: true }).click();
  await stars.getByRole("button", { name: "5 stars", exact: true }).click();
  for (const n of [1, 2])
    await expect(stars.getByRole("button", { name: n === 1 ? "1 star" : `${n} stars`, exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  for (const n of [3, 4, 5])
    await expect(stars.getByRole("button", { name: `${n} stars`, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await expect(tiles).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Filters (2)" })).toBeVisible();

  await page.getByRole("button", { name: "Clear rating" }).click();
  await expect(tiles).toHaveCount(4);
});
