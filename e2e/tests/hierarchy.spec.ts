// L6: text hierarchy holds. Every main page has one h1, heading sizes descend h1 > h2 > h3, and
// headings are no smaller than the page's body text. Plus the two spots U-02 fixes: the New smart
// album title over its sub-heading, and Stats' "Year over year" empty text under its card title.
import type { Locator, Page } from "@playwright/test";
import { SPECIES } from "../support/fixtureCatalog.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { createAlbum, seedTrip, speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

test.beforeEach(() => markKnownFailure(test.info()));

const px = (el: Locator) => el.evaluate((n) => parseFloat(getComputedStyle(n).fontSize));

/** Problems with the page's visible headings, in words. */
async function hierarchyProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const shown = (el: Element) => (el as HTMLElement).checkVisibility() && el.getBoundingClientRect().width > 0;
    const size = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
    const all = Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter(shown)
      .map((el) => ({
        level: Number(el.tagName[1]),
        size: size(el),
        text: el.textContent!.trim().slice(0, 40),
        // A top-level page's h1 is screen-reader only (PageHeader topLevel), so it has no size to compare.
        srOnly: el.getBoundingClientRect().width <= 1,
      }));
    const headings = all.filter((h) => !h.srOnly);
    const problems: string[] = [];
    const h1s = all.filter((h) => h.level === 1);
    if (h1s.length !== 1) problems.push(`${h1s.length} h1s: ${h1s.map((h) => h.text).join(", ")}`);
    for (const [upper, lower] of [
      [1, 2],
      [2, 3],
    ]) {
      const ups = headings.filter((h) => h.level === upper);
      const smallestUp = Math.min(...ups.map((h) => h.size));
      for (const h of headings.filter((x) => x.level === lower && x.size >= smallestUp)) {
        const up = ups.find((u) => u.size === smallestUp)!;
        problems.push(`h${lower} "${h.text}" (${h.size}px) is not smaller than h${upper} "${up.text}" (${up.size}px)`);
      }
    }
    // Body text: the size most paragraphs in the main area use.
    const counts = new Map<number, number>();
    for (const p of Array.from(document.querySelectorAll("main p")))
      if (shown(p) && p.textContent!.trim()) counts.set(size(p), (counts.get(size(p)) ?? 0) + 1);
    const body = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (body)
      for (const h of headings.filter((x) => x.size < body))
        problems.push(`h${h.level} "${h.text}" (${h.size}px) is smaller than body text (${body}px)`);
    return problems;
  });
}

test.describe("text hierarchy", () => {
  const pages: Record<string, (page: Page) => Promise<string>> = {
    collection: async () => "/",
    gallery: async () => "/gallery",
    albums: async () => "/albums",
    "trips list": async () => "/albums?section=trips",
    stats: async () => "/stats",
    settings: async () => "/settings",
    "album detail": async (page) => {
      const trip = await seedRobin(page, "E2E Hierarchy album", 177);
      return `/albums/${await createAlbum(page.request, "E2E Hierarchy", Object.values(trip.captureIds))}`;
    },
    "trip detail": async (page) => `/trips/${(await seedRobin(page, "E2E Hierarchy trip", 178)).id}`,
    "species detail": async (page) => `/species/${await speciesId(page.request, SPECIES.robin)}`,
  };

  for (const [name, url] of Object.entries(pages)) {
    test(`${name}: one h1 and headings descend`, async ({ page }) => {
      await page.goto(await url(page));
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await hierarchyProblems(page)).toEqual([]);
    });
  }
});

const seedRobin = (page: Page, name: string, tint: number) =>
  seedTrip(page.request, name, [{ file: "robin.jpg", species: SPECIES.robin, taken: "2020:05:06 12:00:00", tint }]);

test("New smart album: the title is the dialog's largest text", async ({ page }) => {
  await page.goto("/albums");
  await page.getByRole("button", { name: "New smart album" }).click();
  const dialog = page.getByRole("dialog", { name: "New smart album" });
  const title = dialog.getByRole("heading", { name: "New smart album" });
  const sub = dialog.getByRole("heading", { name: "Or choose your own rules" });
  await expect(title).toBeVisible();
  const titlePx = await px(title);
  if (await sub.count()) expect(await px(sub), "sub-heading").toBeLessThan(titlePx);
  const largestOther = await dialog.evaluate(
    (d, t) =>
      Math.max(
        ...Array.from(d.querySelectorAll("p, h3, h4, label, span"))
          .filter((el) => (el as HTMLElement).checkVisibility() && el.textContent!.trim() && el.textContent !== t)
          .map((el) => parseFloat(getComputedStyle(el).fontSize)),
      ),
    "New smart album",
  );
  expect(largestOther, "largest other text in the dialog").toBeLessThan(titlePx);
  await page.keyboard.press("Escape");
});

test("Stats: Year over year empty text is no larger than its title", async ({ page }) => {
  await page.goto("/stats");
  const title = page.getByRole("heading", { name: "Year over year" });
  await expect(title).toBeVisible();
  const empty = page.getByText("Need photos from at least two different years to compare.");
  // With two years of photos the card shows a table instead, which has no empty text to check.
  test.skip((await empty.count()) === 0, "the library has photos from two years");
  expect(await px(empty)).toBeLessThanOrEqual(await px(title));
});
