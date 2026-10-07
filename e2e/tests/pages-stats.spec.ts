// The Stats page with photos: the insight cards, the chart controls, the photo filter's reload,
// collection intelligence, archive health, year over year and the CSV export. Runs after
// import.spec.ts: see pages-trip-detail.spec.ts. Its photos are the only ones from 2025 and 2026,
// so they're the two years compared by default.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

test("shows stats for the library and exports them", async ({ page }) => {
  await seedTrip(page.request, "E2E Stats", [
    { file: "moose-2025.jpg", species: SPECIES.moose, taken: "2025:12:12 12:00:00", tint: 100 },
    { file: "chickadee-2026.jpg", species: SPECIES.chickadee, taken: "2026:02:02 12:00:00", tint: 110 },
  ]);

  await page.goto("/stats");
  await expect(page.getByRole("heading", { level: 1, name: "Stats" })).toBeVisible();
  await expect(page.getByText("Top camera")).toBeVisible();
  await expect(page.getByText(/E2E Test Camera/).first()).toBeVisible();
  await expect(page.getByText("Peak shooting time")).toBeVisible();

  // The photo filter reloads the stats from the server.
  const featured = page.waitForResponse((res) => res.url().includes("/api/stats?filter=featured"));
  await page.getByLabel("Photos to count").selectOption("featured");
  expect((await featured).ok()).toBe(true);
  const all = page.waitForResponse((res) => res.url().includes("/api/stats?filter=all"));
  await page.getByLabel("Photos to count").selectOption("all");
  expect((await all).ok()).toBe(true);
  await expect(page.getByText("Top camera")).toBeVisible();

  // Chart controls switch what each chart plots.
  await page.getByLabel("Monthly metric").selectOption("keepers");
  await expect(page.getByLabel("Monthly metric")).toHaveValue("keepers");
  await page.getByLabel("X axis").selectOption("iso");
  await page.getByLabel("Y axis").selectOption("aperture");
  await expect(page.getByLabel("X axis")).toHaveValue("iso");
  await page.getByLabel("Gear type").selectOption("lenses");
  await page.getByLabel("Gear metric").selectOption("speciesCount");
  await expect(page.getByLabel("Gear type")).toHaveValue("lenses");
  await page.getByLabel("EXIF field").selectOption("hitRate");
  await expect(page.getByLabel("EXIF field")).toHaveValue("hitRate");

  // Collection intelligence, over the whole library.
  await expect(page.getByRole("heading", { level: 2, name: "Collection intelligence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Most photographed" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: SPECIES.moose.commonName }).first()).toBeVisible();
  await expect(page.getByText(/^0 \/ \d+$/)).toBeVisible();
  await expect(page.getByText("Missing date")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Photography DNA" })).toBeVisible();
  await expect(page.getByText("By taxon")).toBeVisible();

  // Year over year compares the two most recent years, and either can be changed.
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "2026" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "2025" })).toBeVisible();
  const compared = page.waitForResponse((res) =>
    res.url().includes("/api/stats/year-comparison?yearA=2025&yearB=2025"),
  );
  await page.getByLabel("First year").selectOption("2025");
  expect((await compared).ok()).toBe(true);
  await expect(table.getByRole("columnheader", { name: "2026" })).toHaveCount(0);

  await expect(page.getByRole("heading", { level: 2, name: "Collection breakdown" })).toBeVisible();

  // Export downloads a dated CSV for the current filter.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/^lifer-stats-all-\d{4}-\d{2}-\d{2}\.csv$/);
});
