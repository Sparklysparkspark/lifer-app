// The modal contract, for every dialog reachable from the Gallery's selection bar and the search
// palette: the page behind is locked, Tab stays inside, Enter fires the primary action, Escape
// closes the dialog, it fits a small window and it offers a way out. Dialogs are found through
// the shared Modal's `data-modal`; the primary action carries `data-primary`.
// Runs after import.spec.ts: see pages-trip-detail.spec.ts.
import type { Locator, Page } from "@playwright/test";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, seedTrip } from "../support/library.js";
import { expect, test } from "../support/test.js";

const TRIP = "E2E Modals";
const SMALL = { width: 800, height: 600 };

interface Opener {
  name: string;
  open: (page: Page) => Promise<void>;
  /** Enter would delete or send something: the Enter check is skipped. */
  destructive?: boolean;
}

/** A selection-bar action, directly or through its "More" menu when the bar is too narrow. */
const fromSelectionBar = (label: RegExp) => async (page: Page) => {
  const direct = page.getByRole("button", { name: label });
  if (await direct.count()) return void (await direct.first().click());
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: label }).click();
};

const OPENERS: Opener[] = [
  { name: "search palette", open: (page) => page.keyboard.press("Control+k") },
  { name: "add to album", open: fromSelectionBar(/^Add to album/) },
  { name: "add tag", open: fromSelectionBar(/^Add tag/) },
  { name: "correct ID", open: fromSelectionBar(/^Correct ID/) },
  { name: "rate", open: fromSelectionBar(/^Rate/) },
  { name: "set region", open: fromSelectionBar(/^Set region/) },
  { name: "add coordinates", open: fromSelectionBar(/^Add location coordinates/) },
  { name: "adjust date and time", open: fromSelectionBar(/^Adjust date and time/) },
  { name: "delete", open: fromSelectionBar(/^Delete selected/), destructive: true },
];

let tripId = "";

// A failed test restarts the worker and this hook, so the trip is only made once.
test.beforeAll(async ({ request }) => {
  const list = await request.get("/api/trips", { headers: HEADERS });
  const existing = ((await list.json()) as { trips?: Array<{ id: string; name: string }> }).trips?.find(
    (t) => t.name === TRIP,
  );
  if (existing) {
    tripId = existing.id;
    return;
  }
  const trip = await seedTrip(request, TRIP, [
    { file: "chickadee.jpg", species: SPECIES.chickadee, taken: "2021:02:03 12:00:00", tint: 51 },
    { file: "moose-old.jpg", species: SPECIES.moose, taken: "2022:04:05 12:00:00", tint: 61 },
    { file: "moose-new.jpg", species: SPECIES.moose, taken: "2024:09:10 12:00:00", tint: 71 },
  ]);
  tripId = trip.id;
});

async function openModal(page: Page, opener: Opener): Promise<Locator> {
  await page.setViewportSize(SMALL);
  await page.goto(`/gallery?tripId=${tripId}`);
  await expect(page.getByTestId("photo-tile")).toHaveCount(3);
  // The palette opens from anywhere; the rest from the selection bar.
  if (opener.name !== "search palette") {
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("s");
    await page.keyboard.press("Control+a");
    await expect(page.getByText("3 selected")).toBeVisible();
  }
  await opener.open(page);
  const modal = page.locator("[data-modal]");
  await expect(modal).toHaveCount(1);
  return modal;
}

for (const opener of OPENERS) {
  test(`modal contract: ${opener.name}`, async ({ page }) => {
    const modal = await openModal(page, opener);
    const failures: string[] = [];
    const check = (ok: boolean, message: string) => {
      if (!ok) failures.push(message);
    };

    // M3: the page behind can't scroll, and the dialog fits the window.
    const before = await page.evaluate(() => ({ y: scrollY, overflow: getComputedStyle(document.body).overflow }));
    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 600);
    const after = await page.evaluate(() => scrollY);
    check(before.overflow === "hidden", `page scroll is not locked (body overflow is ${before.overflow})`);
    check(after === before.y, `the page scrolled behind the dialog (${before.y} to ${after})`);
    const box = await modal.boundingBox();
    check(
      !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= SMALL.width && box.y + box.height <= SMALL.height,
      `the dialog does not fit ${SMALL.width}x${SMALL.height}: ${JSON.stringify(box)}`,
    );

    // M3: Tab never leaves the dialog, forwards or backwards.
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      const inside = await modal.evaluate((el) => el.contains(document.activeElement));
      if (!inside) {
        failures.push(`${key} moved focus out of the dialog`);
        break;
      }
    }

    // N5: a visible way out.
    const exit = modal.getByRole("button", { name: /^(cancel|close|done|back|not now|ok)\b/i });
    check((await exit.count()) > 0, "no Cancel, Close or Done button");

    // M4: Enter fires the primary action (skipped where it would delete, or has no input yet).
    const primary = modal.locator("[data-primary]");
    const enterable = !opener.destructive && (await primary.count()) > 0 && (await primary.first().isEnabled());
    if (enterable) {
      await modal.focus();
      await page.keyboard.press("Enter");
      const fired = await expect
        .poll(async () => (await modal.count()) === 0 || (await primary.first().getAttribute("aria-busy")) === "true", {
          timeout: 3000,
        })
        .toBe(true)
        .then(
          () => true,
          () => false,
        );
      check(fired, "Enter did not fire the primary action");
    }

    // M3: Escape closes the dialog.
    if (await modal.count()) {
      // From the dialog itself: an open suggestion list in a focused field takes the first Escape.
      await modal.focus();
      await page.keyboard.press("Escape");
      check(
        await expect(modal)
          .toHaveCount(0, { timeout: 3000 })
          .then(
            () => true,
            () => false,
          ),
        "Escape did not close the dialog",
      );
    }
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");

    expect(failures, `${opener.name}: broken modal rules`).toEqual([]);
  });
}
