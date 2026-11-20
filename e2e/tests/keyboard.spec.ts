// U-13: the keymap's keys in the running app. The shortcut sheet opens on ?, the palette on Mod+K,
// and the viewer rates by key position (so AZERTY works), with Shift and a digit rating and moving on.
// The "Desktop Chrome" device reports Windows, so Mod is Ctrl on any host.
import { SPECIES } from "../support/fixtureCatalog.js";
import { seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Keyboard";

test("shortcut sheet, palette, and rating keys in the viewer", async ({ page }) => {
  const trip = await seedTrip(
    page.request,
    TRIP,
    [0, 1, 2].map((i) => ({
      file: `keys-${i}.jpg`,
      species: SPECIES.chickadee,
      taken: `2023:06:0${i + 1} 09:00:00`,
      tint: 210 + i,
    })),
  );
  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  await expect(tiles).toHaveCount(3);

  // ? opens the sheet, which lists the Lightroom rating keys; Esc closes it.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByText("Rate 3 stars and go to the next")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Mod+K toggles the palette.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const ratings: Array<{ id: string; rating: number | null }> = [];
  page.on("request", (r) => {
    const m = r.url().match(/\/api\/captures\/([^/]+)\/rating$/);
    if (m && r.method() === "PATCH")
      ratings.push({ id: m[1], rating: (r.postDataJSON() as { rating: number | null }).rating });
  });

  await tiles.first().getByRole("img").first().click();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();

  // AZERTY: the 1 key types "&" but sits where Digit1 is.
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "&", code: "Digit1", bubbles: true })),
  );
  await expect.poll(() => ratings.length).toBe(1);
  // Shift+3 rates this one and moves to the next, where 2 rates that one.
  await page.keyboard.press("Shift+Digit3");
  await expect.poll(() => ratings.length).toBe(2);
  await page.keyboard.press("Digit2");
  await expect.poll(() => ratings.length).toBe(3);
  expect(ratings.map((r) => r.rating)).toEqual([1, 3, 2]);
  expect(ratings[1].id).toBe(ratings[0].id);
  expect(ratings[2].id).not.toBe(ratings[1].id);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
});
