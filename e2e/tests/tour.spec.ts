// The guided tour (components/Tour.tsx): it starts from Settings and from the palette, waits for
// the Collection to draw, steps with buttons and arrow keys, and ends on Done, Esc or a nav click.
// The "Desktop Chrome" device reports Windows, so Mod is Ctrl on any host.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

async function startFromPalette(page: Page) {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("Take the tour");
  await palette.getByRole("option", { name: "Take the tour", exact: true }).click();
  // Keys go to the palette until it has closed.
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
}

test("the guided tour starts from Settings and the palette, and ends cleanly", async ({ page }) => {
  await page.goto("/settings/general");
  await page.getByRole("button", { name: "Take the tour" }).click();

  const card = page.getByRole("dialog", { name: "Import photos" });
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/\/(\?[^#]*)?$/);
  const total = Number((await card.getByText(/^1 of \d+$/).textContent())!.split(" of ")[1]);
  expect(total).toBeGreaterThanOrEqual(6);

  // The card stays inside the window.
  const box = (await page.getByTestId("tour-card").boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);

  const tour = page.getByTestId("tour-card");
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByText(`2 of ${total}`)).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tour.getByText(`1 of ${total}`)).toBeVisible();
  for (let i = 1; i < total; i++) await page.keyboard.press("ArrowRight");
  await expect(tour.getByRole("heading", { name: "Photo versions" })).toBeVisible();
  await tour.getByRole("button", { name: "Done" }).click();
  await expect(tour).toHaveCount(0);

  // From the palette; Esc ends it where it is.
  await startFromPalette(page);
  await expect(tour).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);

  // A nav click ends it and simply goes there.
  await startFromPalette(page);
  await expect(tour).toBeVisible();
  await page.getByRole("link", { name: "Gallery", exact: true }).first().click();
  await expect(page).toHaveURL(/\/gallery/);
  await expect(tour).toHaveCount(0);
});
