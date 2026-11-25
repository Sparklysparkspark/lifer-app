// Every page in the top nav opens from the nav and renders, with no page error, console error or
// error toast (checked for every test by support/test.ts).
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

// The nav link, and something each page renders only once its data has loaded (the headings
// show while loading, so they alone would pass before a failing request).
const PAGES: Array<{ link: string; url: RegExp; heading: string; loaded: (page: Page) => Locator }> = [
  {
    link: "Import",
    url: /\/import$/,
    heading: "Import photos",
    loaded: (page) => page.getByText("Drag photos, RAWs or videos here, or choose them."),
  },
  {
    link: "Stats",
    url: /\/stats$/,
    heading: "Stats",
    // An empty library has nothing to export, so it shows its empty state instead.
    loaded: (page) =>
      page.getByRole("button", { name: "Export CSV" }).or(page.getByRole("heading", { name: "No stats yet" })),
  },
  {
    link: "Gallery",
    url: /\/gallery$/,
    heading: "Gallery",
    loaded: (page) => page.getByLabel("Search your photos by what's in them"),
  },
  {
    link: "Albums",
    url: /\/albums$/,
    heading: "Albums",
    // It opens on the Albums section (Trips is the other one, remembered once chosen).
    loaded: (page) => page.getByRole("button", { name: "New album", exact: true }),
  },
  {
    link: "Settings",
    url: /\/settings$/,
    heading: "Settings",
    // The default group's first setting, once the page has worked out which groups to show.
    loaded: (page) => page.getByRole("button", { name: "Follow system" }),
  },
];

test("every top-level page loads cleanly", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation");
  for (const target of PAGES) {
    await nav.getByRole("link", { name: target.link, exact: true }).click();
    await expect(page).toHaveURL(target.url);
    await expect(page.getByRole("heading", { level: 1, name: target.heading })).toBeVisible();
    await expect(target.loaded(page)).toBeVisible();
  }

  // The logo goes back to the collection, the page the app opens on.
  await page.getByLabel("Collection").click();
  // The page header's count; the class bands and cards say it too.
  await expect(page.locator("[data-tour=collection-header]").getByText(/^\d+ of \d+ photographed$/)).toBeVisible();
});

test("missing files are 404s, while app routes get the web app", async ({ request }) => {
  // The offline map was never downloaded here: answering with the app's HTML would make the web
  // app believe it exists.
  expect((await request.get("/maps/world-z8.pmtiles")).status()).toBe(404);
  expect((await request.get("/api/does-not-exist")).status()).toBe(404);
  const deepLink = await request.get("/settings/general");
  expect(deepLink.status()).toBe(200);
  expect(await deepLink.text()).toContain('<div id="root">');
});

test("Species downloads load cleanly in Settings without a downloaded map, from Species and import", async ({
  page,
}) => {
  await page.goto("/settings/species");
  await page.getByRole("link", { name: /Download more countries and animal groups/ }).click();
  await expect(page).toHaveURL(/\/settings\/species\/downloads$/);
  await expect(page.getByRole("heading", { level: 2, name: "Species downloads" })).toBeVisible();
  // Settings keeps Species and import lit, and the page leads back to it.
  await expect(page.getByRole("link", { name: "Species and import", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "← Species and import" }).click();
  await expect(page).toHaveURL(/\/settings\/species$/);
  // The old address still lands here.
  await page.goto("/settings/regions");
  await expect(page).toHaveURL(/\/settings\/species\/downloads$/);
});

test("old Regions and Trips addresses land on their new homes", async ({ page }) => {
  await page.goto("/offline-packs?missing=Ardea%20herodias");
  await expect(page).toHaveURL(/\/settings\/species\/downloads\?missing=Ardea%20herodias$/);
  await page.goto("/trips");
  await expect(page).toHaveURL(/\/albums\?view=trips$/);
  await expect(page.getByRole("heading", { level: 1, name: "Trips" })).toBeAttached();
});

test("a page opened from a URL goes back into the app, even after a redirect landed on it", async ({ page }) => {
  await page.goto("/trash");
  // What a redirect leaves behind (signing in first, say): the first entry of the visit, with a key.
  await page.evaluate(() => window.history.replaceState({ usr: null, key: "redirected", idx: 0 }, ""));
  await page.reload();
  await page.getByRole("button", { name: "← Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});
