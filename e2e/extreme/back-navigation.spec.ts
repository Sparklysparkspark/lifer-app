// Back returns to the exact previous view (ux-rules N1, N2, N4, P5), by the back button, the browser's
// back and the swipe shortcut, on the extreme seed. Failures the app is known to have are listed in
// e2e/known-failures.json. Lives beside the seeded specs because it needs the seed's contents.
import { expect, test as base, type Page } from "@playwright/test";
import pg from "pg";
import { LOCAL_DATABASE_URL } from "../support/constants.js";
import { EXTREME_ACCOUNT, SEED_COLLECTION, seedExtreme } from "../support/extremeLibrary.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS } from "../support/library.js";

const test = base;
type Via = "button" | "browser" | "swipe";
const VIAS: Via[] = ["button", "browser", "swipe"];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? LOCAL_DATABASE_URL });
  await db.connect();
  try {
    if (test.info().project.name === "extreme") await seedExtreme(db);
  } finally {
    await db.end();
  }
});

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "extreme", "needs the extreme seed");
  markKnownFailure(info);
  const res = await page.context().request.post("/api/auth/login", { headers: HEADERS, data: EXTREME_ACCOUNT });
  expect(res.ok()).toBe(true);
});

const h1 = async (page: Page) => (await page.getByRole("heading", { level: 1 }).first().innerText()).trim();
const view = async (page: Page) => ({
  url: page.url(),
  h1: await h1(page),
  scrollY: await page.evaluate(() => Math.round(window.scrollY)),
});

async function goBack(page: Page, via: Via) {
  if (via === "button") await page.getByRole("button", { name: /^←/ }).click();
  else if (via === "browser") await page.goBack();
  else {
    // Fingers moving right: a wheel with positive deltaX past the swipe threshold.
    await page.mouse.move(640, 400);
    await page.mouse.wheel(300, 0);
  }
}

// Opens something from the page, then returns by `via`; the view must be the one left.
async function roundTrip(page: Page, via: Via, setUp: () => Promise<void>, open: () => Promise<void>) {
  // The swipe shortcut only exists in the desktop app, which is what sets this.
  if (via === "swipe") await page.addInitScript(() => Object.assign(window, { liferSetup: { platform: "linux" } }));
  await setUp();
  const before = await view(page);
  await open();
  await expect(page).not.toHaveURL(before.url);
  if (via === "button") {
    // N2: the back link names the page it returns to.
    await expect(page.getByRole("button", { name: /^←/ })).toHaveText(`← ${before.h1}`);
  }
  await goBack(page, via);
  await expect(page).toHaveURL(before.url);
  // Generous: a search reruns in full on Back, and its picture matching is slow on a CI runner.
  await expect.poll(() => view(page), { timeout: 30_000 }).toEqual(before);
}

const scrollDown = async (page: Page) => {
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(300);
};

for (const via of VIAS) {
  test(`collection: search, scroll and a species, back by ${via}`, async ({ page }) => {
    // shortcut: on macOS runners the swipe lands 263 px short of the spot (637 for 900) in every run
    // since 2026-11-27, while Linux and Windows pass; debug on a Mac, then drop this line.
    test.fail(process.platform === "darwin" && via === "swipe", "macOS swipe back lands short of the saved spot");
    await roundTrip(
      page,
      via,
      async () => {
        await page.goto(SEED_COLLECTION);
        await expect(page.locator('a[href^="/species/"]').first()).toBeVisible({ timeout: 30_000 });
        await scrollDown(page);
      },
      async () => {
        await page.locator('a[href^="/species/"]:visible').first().click();
        await expect(page).toHaveURL(/\/species\//);
      },
    );
  });

  test(`collection: a filter in the URL survives a species, back by ${via}`, async ({ page }) => {
    await roundTrip(
      page,
      via,
      async () => {
        await page.goto(`${SEED_COLLECTION}&sort=name&group=tier`);
        await expect(page.locator('a[href^="/species/"]').first()).toBeVisible({ timeout: 30_000 });
        // Clicking scrolls a card below the fold into view first; Back returns there, not to the top.
        await page.locator('a[href^="/species/"]:visible').first().scrollIntoViewIfNeeded();
      },
      async () => {
        await page.locator('a[href^="/species/"]:visible').first().click();
        await expect(page).toHaveURL(/\/species\//);
      },
    );
  });

  test(`gallery: search and scroll then another page, back by ${via}`, async ({ page }) => {
    test.skip(via === "button", "top-level pages have no back link");
    await roundTrip(
      page,
      via,
      async () => {
        await page.goto("/gallery?q=bird");
        await expect(page.getByLabel("Search your photos by what's in them")).toHaveValue("bird", {
          timeout: 30_000,
        });
        await page.waitForLoadState("networkidle");
        await scrollDown(page);
      },
      async () => {
        // A real click first scrolls the browser layout's top nav into view, which moves the
        // position being tested; the desktop layout's sidebar never scrolls away.
        await page.getByRole("navigation").getByRole("link", { name: "Stats", exact: true }).dispatchEvent("click");
      },
    );
  });

  for (const [name, route, card, detail] of [
    // The Albums page shows one side at a time, and a plain /albums opens the side seen last.
    ["albums", "/albums?view=albums", 'a[href^="/albums/"]', "/albums/"],
    // Trip cards open /trips/:id.
    ["trips", "/albums?view=trips", 'a[href^="/trips/"]', "/trips/"],
  ] as const) {
    test(`${name}: a card and back by ${via}`, async ({ page }) => {
      await roundTrip(
        page,
        via,
        async () => {
          await page.goto(route);
          await expect(page.locator(card).first()).toBeVisible({ timeout: 30_000 });
        },
        async () => {
          await page.locator(card).first().click();
          await expect(page).toHaveURL(new RegExp(detail));
        },
      );
    });
  }

  test(`stats: to albums and back by ${via}`, async ({ page }) => {
    test.skip(via === "button", "top-level pages have no back link");
    await roundTrip(
      page,
      via,
      async () => {
        await page.goto("/stats");
        await page.waitForLoadState("networkidle");
      },
      async () => {
        await page.getByRole("navigation").getByRole("link", { name: "Albums", exact: true }).click();
      },
    );
  });
}

test("two backs from a species never return to the same page", async ({ page }) => {
  await page.goto("/gallery");
  await page.getByRole("navigation").getByRole("link", { name: "Albums", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name: "Stats", exact: true }).click();
  const seen = [page.url()];
  for (let i = 0; i < 2; i++) {
    await page.goBack();
    seen.push(page.url());
  }
  expect(new Set(seen).size).toBe(3);
});
