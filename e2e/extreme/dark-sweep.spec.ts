// Dark mode sweep (ux-rules T1): every main page under a dark system theme has no large light
// surface, and the html and body backgrounds match.
import { expect, test } from "@playwright/test";
import { seedForProject, SWEEP_PAGES } from "../support/sweep.js";

seedForProject();
test.use({ colorScheme: "dark" });
// No saved theme: the app follows the dark system setting from first launch.

for (const route of SWEEP_PAGES) {
  test(`${route} follows dark mode`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");

    const { light, htmlBg, bodyBg, dark } = await page.evaluate(() => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const light: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width * rect.height <= 10_000) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const [r, g, b, a = 1] = parse(style.backgroundColor);
        if (a < 0.5 || lum([r, g, b]) < 0.6) continue;
        light.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} ${style.backgroundColor}`);
      }
      return {
        light,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        dark: document.documentElement.classList.contains("dark"),
      };
    });
    expect(dark, "the dark theme is applied").toBe(true);
    expect(bodyBg, "html and body backgrounds match").toBe(htmlBg);
    expect(light, "large light elements in dark mode").toEqual([]);
  });
}
