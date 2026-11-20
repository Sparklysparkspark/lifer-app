// Journey (T-02): remove the country's packs, look around, download them again. Photos stay, the
// Collection falls back without an error, and comes back as it was (remembered-state.md).
import { COUNTRY, SPECIES } from "../../support/fixtureCatalog.js";
import { HEADERS, seedTrip } from "../../support/library.js";
import { expect, test } from "../../support/test.js";

test("remove a region, keep the photos, download it again", async ({ page }) => {
  test.setTimeout(120_000);
  const request = page.request;
  const trip = await seedTrip(request, "E2E Journey Region", [
    { file: "moose.jpg", species: SPECIES.moose, taken: "2017:09:01 12:00:00", tint: 184 },
  ]);
  const tiles = page.getByTestId("photo-tile");
  const country = page.getByRole("button", { name: new RegExp(`^${COUNTRY.name}`) });
  try {
    await page.goto("/settings/species/downloads");
    await country.click();
    await page.getByRole("button", { name: "Remove", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${COUNTRY.name} \\(2 regions\\)`) })).toBeVisible({
      timeout: 15_000,
    });

    // The Collection still opens, and the photo is still in the Gallery.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.goto(`/gallery?tripId=${trip.id}`);
    await expect(tiles).toHaveCount(1);

    // Download it again from the same page.
    await page.goto("/settings/species/downloads");
    await page.getByRole("button", { name: "North America" }).click();
    await page.getByRole("button", { name: COUNTRY.name, exact: true }).click();
    // No animal group is chosen for you: take them all, which brings back whichever was removed.
    await page
      .getByText(/selected\. Choose animal groups$/)
      .locator("xpath=..")
      .getByRole("button", { name: "Select all" })
      .click();
    await page.getByRole("button", { name: "Download selected" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${COUNTRY.name} \\(3 regions\\)`) })).toBeVisible({
      timeout: 30_000,
    });

    // The Collection is back, with the moose photographed.
    await page.goto("/?show=collected");
    await expect(page.getByText(SPECIES.moose.commonName).first()).toBeVisible();
  } finally {
    // Later specs need every pack; a no-op when they are all there.
    await request.post("/api/offline-packs/download-batch", {
      headers: HEADERS,
      data: { regionNames: [COUNTRY.name], taxa: "all" },
    });
    await expect
      .poll(async () => (await (await request.get("/api/offline-packs/download/status")).json()).running, {
        timeout: 30_000,
      })
      .toBe(false);
  }
});
