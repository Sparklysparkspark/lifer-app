// Every page in the top nav opens from the nav and renders, with no page error, console error or
// error toast (checked for every test by support/test.ts).
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

// The nav link, and something each page renders only once its data has loaded (the headings
// show while loading, so they alone would pass before a failing request).
const PAGES: Array<{ link: string; url: RegExp; heading: string; loaded: (page: Page) => Locator }> = [
  { link: "Import", url: /\/import$/, heading: "Bulk import", loaded: (page) => page.getByText("choose files") },
  {
    link: "Stats",
    url: /\/stats$/,
    heading: "Stats",
    loaded: (page) => page.getByRole("button", { name: "Export CSV" }),
  },
  {
    link: "Gallery",
    url: /\/gallery$/,
    heading: "Gallery",
    loaded: (page) => page.getByPlaceholder(/^Search your photos/),
  },
  {
    link: "Albums & trips",
    url: /\/albums$/,
    heading: "Albums & trips",
    loaded: (page) => page.getByRole("button", { name: "Trips" }),
  },
  {
    link: "Settings",
    url: /\/settings$/,
    heading: "Settings",
    // The default group's first card, once the page has worked out which groups to show.
    loaded: (page) => page.getByText("Light or dark mode, or follow whatever this device is set to."),
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
  await page.getByRole("link", { name: "Collection" }).click();
  await expect(page.getByText(/^\d+ \/ \d+ collected$/)).toBeVisible();
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

test("the offline packs page loads cleanly without a downloaded map", async ({ page }) => {
  await page.goto("/offline-packs");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a page opened from a URL goes back into the app, even after a redirect landed on it", async ({ page }) => {
  await page.goto("/offline-packs");
  // What a redirect leaves behind (signing in first, say): the first entry of the visit, with a key.
  await page.evaluate(() => window.history.replaceState({ usr: null, key: "redirected", idx: 0 }, ""));
  await page.reload();
  await page.getByRole("button", { name: "← Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});
