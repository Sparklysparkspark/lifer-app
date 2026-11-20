// F-04: a dismissed smart album suggestion comes back through "Show dismissed".
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Suggestion Restore";
// Photos with no region always make this housekeeping suggestion, given enough of them.
const SUGGESTION = "Missing a region";

test("dismisses a smart album suggestion and restores it", async ({ page }) => {
  // MIN_SUGGESTION_PHOTOS in apps/api/src/albums/suggestions.ts.
  await seedTrip(
    page.request,
    TRIP,
    Array.from({ length: 8 }, (_, i) => ({
      file: `restore-${i}.jpg`,
      species: SPECIES.robin,
      taken: `2020:09:0${i + 1} 14:17:00`,
      tint: 186 + i,
    })),
  );

  await page.goto("/albums");
  await page.getByRole("button", { name: "New smart album" }).click();
  const builder = page.getByRole("dialog", { name: "New smart album" });
  const card = builder.getByRole("region", { name: SUGGESTION });
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);

  await builder.getByRole("button", { name: "Show dismissed" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(card).toHaveCount(0);

  // Back among the suggestions, also after the builder opens afresh.
  await page.keyboard.press("Escape");
  await expect(builder).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "New smart album" }).click();
  await expect(card).toBeVisible();
  await expect(builder.getByRole("button", { name: "Show dismissed" })).toHaveCount(0);
});
