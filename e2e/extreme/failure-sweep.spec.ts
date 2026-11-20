// Failure sweep (ux-rules S1 to S4, S9): every main page with its API calls failing, timing out,
// slow and offline, plus sparse-data and image checks. Raw server text is injected into the
// 500 body so any leak into the page shows up.
import { expect, test, type Page, type Route } from "@playwright/test";
import { seedForProject, bodyText, SWEEP_PAGES } from "../support/sweep.js";

seedForProject();

const RAW_BODY = { error: "deadlock detected ENOENT: no such file /srv/x constraint violation" };
const RAW = /EPERM|ENOENT|deadlock|constraint|Error:|\b(?:HTTP|status)\s*:?\s*[45]\d\d\b|\/srv\//;
// Whole tokens only, so words like "annulled" never match.
const EMPTY_VALUE = /\bundefined\b|\bnull\b|\bNaN\b|\[object /;

// Sign-in and health stay up so the failure is the page's data, not the session.
const isData = (url: URL) => url.pathname.startsWith("/api/") && !/^\/api\/(auth|health)\b/.test(url.pathname);

const MODES: Record<string, (route: Route) => Promise<void>> = {
  "500": (route) => route.fulfill({ status: 500, json: RAW_BODY }),
  timeout: (route) => route.abort("timedout"),
  offline: (route) => route.abort("internetdisconnected"),
  slow: async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue().catch(() => undefined);
  },
};

async function expectImagesLoaded(page: Page) {
  const broken = await page.evaluate(() =>
    Array.from(document.images)
      // No src yet is a tile still far off screen (ProgressiveImg), not a failed load.
      .filter((i) => i.hasAttribute("src") && i.getBoundingClientRect().width > 0 && i.complete && i.naturalWidth === 0)
      .map((i) => i.currentSrc || i.src),
  );
  expect(broken, "images that failed to load").toEqual([]);
}

for (const [mode, handler] of Object.entries(MODES)) {
  for (const route of SWEEP_PAGES) {
    test(`${route} with API ${mode}`, async ({ page }) => {
      test.setTimeout(90_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.route((url) => isData(url), handler);
      // Aborted requests leave navigator.onLine true, so the browser's offline flag is set too.
      if (mode === "offline")
        await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => false }));
      await page.goto(route);
      await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => undefined);
      await page.waitForTimeout(500);

      await expect(page.getByRole("navigation").first(), "the sidebar stays (S3)").toBeVisible();
      expect(pageErrors, "uncaught page errors (S3)").toEqual([]);
      const text = await bodyText(page);
      expect(text.match(RAW)?.[0], "raw error text on the page (S1)").toBeUndefined();
      expect(text.match(EMPTY_VALUE)?.[0], "empty value on the page (S2)").toBeUndefined();

      if (mode === "slow") {
        await expectImagesLoaded(page);
        await expect(page.getByRole("alert")).toHaveCount(0);
      } else {
        // Failed data is a styled message with a way to try again, or the page's own empty state.
        const retry = page.getByRole("button", { name: /retry|try again/i });
        await expect(retry.first(), "a Retry button shows (S3)").toBeVisible({ timeout: 5000 });
      }
      if (mode === "offline") {
        await expect(page.getByText(/offline/i).first(), "an offline notice (S9)").toBeVisible();
      }
    });
  }
}

test.describe("data sweep", () => {
  for (const route of SWEEP_PAGES) {
    test(`${route} has no empty values and loads every image`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState("networkidle");
      // Lazy images only load once scrolled to.
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(500);
      expect(pageErrors).toEqual([]);
      expect((await bodyText(page)).match(EMPTY_VALUE)?.[0], "empty value on the page (S2)").toBeUndefined();
      await expectImagesLoaded(page);
    });
  }
});
