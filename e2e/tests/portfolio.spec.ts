// Portfolio (N-05): pick an album and the life list, save the site to a folder, then open the saved
// pages straight from disk. Screenshots of the site land in test-results/portfolio-site for review.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SPECIES } from "../support/fixtureCatalog.js";
import { createAlbum, exportsFolder, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const ALBUM = "E2E Portfolio album";
const TITLE = "E2E Wildlife Portfolio";
const SHOTS = path.join("test-results", "portfolio-site");

test("saves the portfolio as a website that opens from the folder", async ({ page }) => {
  const trip = await seedTrip(page.request, "E2E Portfolio", [
    { file: "portfolio-moose.jpg", species: SPECIES.moose, taken: "2019:08:02 12:00:00", tint: 162 },
    { file: "portfolio-chickadee.jpg", species: SPECIES.chickadee, taken: "2019:08:03 12:00:00", tint: 163 },
  ]);
  await createAlbum(page.request, ALBUM, Object.values(trip.captureIds));
  const destination = path.join(await exportsFolder(page.request), "e2e-portfolio-site");
  mkdirSync(destination, { recursive: true });
  // The folder browser opens where the last export went.
  await page.addInitScript((folder) => localStorage.setItem("lifer:portfolioExportFolder", folder), destination);

  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
  await page.getByLabel("Title", { exact: true }).fill(TITLE);
  await page.getByRole("checkbox", { name: ALBUM }).check();
  const lifeList = page.getByRole("switch", { name: "Life list page" });
  if ((await lifeList.getAttribute("aria-checked")) !== "true") await lifeList.click();
  await expect(page.getByText(/^2 photos\. The site never shows where a photo was taken\.$/)).toBeVisible();
  await expect(page.frameLocator('iframe[title="Preview"]').getByRole("heading", { name: TITLE })).toBeVisible();

  await page.getByRole("button", { name: "Save to a folder" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.getByText(/^Saved the site into .*e2e-portfolio-site, with \d+ photo files?\.$/)).toBeVisible({
    timeout: 30_000,
  });

  const index = path.join(destination, "index.html");
  const lifeListPage = path.join(destination, "life-list.html");
  expect(existsSync(index)).toBe(true);
  expect(existsSync(lifeListPage)).toBe(true);
  // Nothing the pages load leaves the folder, and no coordinates are written into them.
  for (const file of [index, lifeListPage]) {
    const html = readFileSync(file, "utf8");
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).not.toMatch(/-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/);
  }

  mkdirSync(SHOTS, { recursive: true });
  const site = await page.context().newPage();
  const offsite: string[] = [];
  site.on("request", (req) => {
    if (!req.url().startsWith("file:")) offsite.push(req.url());
  });
  for (const scheme of ["light", "dark"] as const) {
    await site.emulateMedia({ colorScheme: scheme });
    for (const [width, label] of [
      [1280, "desktop"],
      [390, "phone"],
    ] as const) {
      await site.setViewportSize({ width, height: 900 });
      await site.goto(pathToFileURL(index).href);
      await expect(site.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
      const images = site.getByRole("img");
      await expect(images).toHaveCount(2);
      for (const img of await images.all())
        await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      await site.screenshot({ path: path.join(SHOTS, `index-${label}-${scheme}.png`), fullPage: true });

      await site.getByRole("link", { name: "Life list" }).click();
      await expect(site).toHaveURL(/life-list\.html$/);
      await expect(site.getByRole("cell", { name: new RegExp(SPECIES.moose.commonName) })).toBeVisible();
      await site.screenshot({ path: path.join(SHOTS, `life-list-${label}-${scheme}.png`), fullPage: true });
    }
  }
  expect(offsite, "the saved site asks for nothing outside its folder").toEqual([]);
  await site.close();
});
