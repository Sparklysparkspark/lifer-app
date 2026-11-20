// U-01: the selection bar stays in view while the grid scrolls, and "Clear all filters" removes
// every filter and its URL params.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Gallery Selection";
const COUNT = 16;

test("the selection bar stays in view while scrolling, and Clear all filters clears every filter", async ({ page }) => {
  const trip = await seedTrip(
    page.request,
    TRIP,
    Array.from({ length: COUNT }, (_, i) => ({
      file: `selection-${i}.jpg`,
      species: SPECIES.chickadee,
      taken: `2023:05:${String(i + 1).padStart(2, "0")} 14:17:00`,
      tint: 160 + i,
    })),
  );
  // Short enough that the grid scrolls.
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(`/gallery?tripId=${trip.id}&missingCoordinates=1&q=chickadee`);
  const search = page.getByLabel("Search your photos by what's in them");
  await expect(page.getByText(new RegExp(`^${COUNT} photos`))).toBeVisible();

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByTestId("photo-tile").first().getByRole("checkbox", { name: "Select photo" }).check();
  const selected = page.getByText("1 selected");
  await expect(selected).toBeInViewport();

  await page.getByTestId("photo-tile").first().hover();
  await page.mouse.wheel(0, 3000);
  await expect(search).not.toBeInViewport();
  await expect(selected).toBeInViewport();
  await expect(page.getByRole("button", { name: "Correct ID" })).toBeInViewport();

  await page.mouse.wheel(0, -3000);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);

  // The trip scope, the missing-coordinates filter and the search all go, from the page and the URL.
  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(page).not.toHaveURL(/[?&](tripId|missingCoordinates|q)=/);
  await expect(page.getByText(`In trip ${TRIP}`)).toHaveCount(0);
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear all filters" })).toHaveCount(0);
});
