// Importing a trip a culling app has been through: the scan counts the photos it rejected (rating
// -1, or a digiKam pick label of Rejected), skips them by default, can import them hidden instead,
// and the Gallery's Hidden filter unhides them. The picked photo's mark shows in the lightbox.
//
// Runs after import.spec.ts: see pages-trip-detail.spec.ts. Its photos are from 2019, a year no
// other spec uses, and the later specs only count chickadees within their own trips.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ExifTool } from "exiftool-vendored";
import { SPECIES } from "../support/fixtureCatalog.js";
import { createTrip, writeTripFolder } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Culled Trip";
const BIRD = SPECIES.chickadee;

async function pickSpecies(page: Page, file: string): Promise<void> {
  const row = page.locator(`[data-import-row="${file}"]`);
  const picker = row.getByRole("combobox", { name: "Type a species…" });
  if (!(await picker.isVisible())) await row.getByRole("button", { name: "Type a species…" }).click();
  await picker.fill("chickadee");
  await page.getByRole("option", { name: new RegExp(BIRD.commonName) }).click();
}

test("honours a culling app's rejects and picks when importing a trip", async ({ page }) => {
  const folder = await writeTripFolder(page.request, "culled", [
    { file: "keeper.jpg", species: BIRD, taken: "2019:08:03 12:00:00", tint: 130 },
    { file: "blurry.jpg", species: BIRD, taken: "2019:08:02 12:00:00", tint: 140 },
    { file: "empty-perch.jpg", species: BIRD, taken: "2019:08:01 12:00:00", tint: 150 },
  ]);
  // What the culling apps leave in the files: a digiKam Accepted pick with a red label, a
  // Bridge-style reject (rating -1) and a digiKam Rejected pick label.
  const exiftool = new ExifTool();
  try {
    const write = (file: string, tags: Record<string, unknown>) =>
      exiftool.write(path.join(folder, file), tags as never, { writeArgs: ["-overwrite_original"] });
    await write("keeper.jpg", { "XMP-digiKam:PickLabel": 3, "XMP-xmp:Label": "Red" });
    await write("blurry.jpg", { "XMP-xmp:Rating": -1 });
    await write("empty-perch.jpg", { "XMP-digiKam:PickLabel": 1 });
  } finally {
    await exiftool.end();
  }
  const sources = ["keeper.jpg", "blurry.jpg", "empty-perch.jpg"].map((f) => path.join(folder, f));
  const before = sources.map((f) => readFileSync(f));
  const tripId = await createTrip(page.request, TRIP, folder);

  // The scan counts the rejects and, by default, leaves them out of the review.
  await page.goto(`/trips/${tripId}`);
  await page.getByRole("button", { name: "Add more photos" }).first().click();
  await expect(page.getByTestId("cull-summary")).toHaveText("3 photos, 2 marked rejected by your culling app.");
  await expect(page.getByLabel("Rejected photos")).toHaveValue("skip");
  await expect(page.getByText("1 new photo · 0 ready to import")).toBeVisible();
  await expect(page.locator('[data-import-row="blurry.jpg"]')).toHaveCount(0);

  // Importing them hidden brings them back into the review, marked.
  await page.getByLabel("Rejected photos").selectOption("hide");
  await expect(page.getByText("3 new photos · 0 ready to import")).toBeVisible();
  await expect(
    page.locator('[data-import-row="blurry.jpg"]').getByText("Rejected in your culling app, will be imported hidden"),
  ).toBeVisible();
  for (const file of ["keeper.jpg", "blurry.jpg", "empty-perch.jpg"]) await pickSpecies(page, file);
  await expect(page.getByText("3 new photos · 3 ready to import")).toBeVisible();
  await page.getByRole("button", { name: "Import 3 photos" }).click();

  // Only the keeper shows on the trip; the rejects were imported hidden.
  await expect(page.getByTestId("cull-import-outcome")).toHaveText(
    "2 photos rejected in your culling app imported hidden.",
    { timeout: 20_000 },
  );
  const tripTiles = page.getByTestId("photo-tile");
  await expect(tripTiles).toHaveCount(1);
  await expect(page.getByText("· 1 photo")).toBeVisible();

  // The source files are exactly as they were.
  sources.forEach((f, i) => expect(readFileSync(f).equals(before[i])).toBe(true));

  // The Gallery's Hidden filter lists the two, and one can be unhidden.
  await page.goto(`/gallery?tripId=${tripId}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(1);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("checkbox", { name: "Hidden" }).check();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(tiles).toHaveCount(2);
  // Newest first: the 2019-08-02 reject.
  await tiles.first().getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Unhide" }).click();
  await expect(page.getByText("Unhid 1 photo")).toBeVisible();
  await expect(tiles).toHaveCount(1);

  // Back in the normal view, the trip has two photos, and the lightbox shows each one's mark.
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("checkbox", { name: "Hidden" }).uncheck();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(tiles).toHaveCount(2);
  await tiles.first().getByRole("img").click();
  await expect(page.getByText("Picked in your culling app · Red label")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Rejected in your culling app", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
});
