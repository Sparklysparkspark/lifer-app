// Shared by the tour and the behavioural checks: the specs' `test` (which already fails on page
// errors, console errors and error toasts) plus a check for failed requests, and helpers that
// wait for a page to settle before it is looked at.
import { expect, type Page } from "@playwright/test";
import { test as base } from "../support/test.js";

export const VISUAL_AUTH_STATE = "test-results/.auth/visual-user.json";

export const test = base.extend<{ failedRequests: string[] }>({
  failedRequests: [
    async ({ page }, use) => {
      const failed: string[] = [];
      page.on("requestfailed", (req) => {
        // A navigation or a view change cancels requests it no longer needs; that isn't a failure.
        const reason = req.failure()?.errorText ?? "";
        if (/abort|cancel/i.test(reason)) return;
        failed.push(`${req.method()} ${req.url()}: ${reason}`);
      });
      page.on("response", (res) => {
        if (res.status() >= 400) failed.push(`${res.request().method()} ${res.url()}: ${res.status()}`);
      });
      await use(failed);
      expect(failed, "requests failed").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export const CARD_SIZES = { smallest: 120, default: 160 } as const;

/** Sets the Collection's card size before the app reads it (hooks/useSpeciesCardSize.ts). */
export async function setCardSize(page: Page, size: number): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("lifer:speciesCardMinWidth", JSON.stringify(value));
  }, size);
}

/** Network quiet, fonts loaded, every image in view decoded and the region map (if any) idle. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => {
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const images = Array.from(document.images).filter((img) => img.getAttribute("src") && inView(img));
    if (!images.every((img) => img.complete)) return false;
    const map = document.querySelector<HTMLElement>("[data-testid=region-map]");
    return !map || !!map.dataset.viewBounds;
  });
  await page.waitForLoadState("networkidle");
}

/** The id of a region by name, from the API the app uses. */
export async function regionId(page: Page, name: string): Promise<string> {
  const res = await page.request.get("/api/regions", { headers: { "x-lifer-client": "1" } });
  const { regions } = (await res.json()) as { regions: Array<{ id: string; name: string }> };
  const match = regions.find((r) => r.name === name);
  if (!match) throw new Error(`No region named ${name}`);
  return match.id;
}
