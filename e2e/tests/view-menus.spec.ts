// C3, C4: every page with a View menu uses the one shared component (same trigger, same panel), and
// the grids the plan names offer a size control in it. N3: album and trip card sizes survive a reload.
import type { Page } from "@playwright/test";
import { SPECIES } from "../support/fixtureCatalog.js";
import { createAlbum, seedTrip, speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

const VIEW = /^View( \(\d+\))?$/;

interface Look {
  trigger: string;
  panel: string;
  sizeControl: boolean;
}

/** Opens the page's View menu and returns the shared component's fingerprint plus its size control. */
async function openView(page: Page, url: string): Promise<Look> {
  await page.goto(url);
  const trigger = page.getByRole("button", { name: VIEW });
  await expect(trigger, `${url} has one View menu`).toHaveCount(1);
  await trigger.click();
  const panel = trigger.locator("xpath=following-sibling::div[1]");
  await expect(panel).toBeVisible();
  // Album and trip pages show species first; the photo grid's size lives under Photos.
  // Show is the shared SegmentedControl, whose segments are pressed buttons.
  const photos = panel.getByRole("button", { name: "Photos", exact: true });
  if (await photos.count()) {
    await photos.click();
    await expect(photos).toHaveAttribute("aria-pressed", "true");
  }
  const look = {
    trigger: (await trigger.getAttribute("class")) ?? "",
    panel: (await panel.getAttribute("class")) ?? "",
    sizeControl: (await panel.getByRole("slider").count()) === 1,
  };
  await page.keyboard.press("Escape");
  return look;
}

test("every View menu is the shared one, with a size control where the plan puts one", async ({ page }) => {
  const trip = await seedTrip(page.request, "E2E View menus", [
    { file: "moose-view.jpg", species: SPECIES.moose, taken: "2023:06:07 12:00:00", tint: 163 },
  ]);
  const album = await createAlbum(page.request, "E2E View menus", Object.values(trip.captureIds));
  const moose = await speciesId(page.request, SPECIES.moose);

  const pages: Record<string, string> = {
    Collection: "/",
    Gallery: "/gallery",
    "Albums list": "/albums?section=albums",
    "Trips list": "/albums?section=trips",
    "Album detail": `/albums/${album}`,
    "Trip detail": `/trips/${trip.id}`,
    "Species photos": `/species/${moose}`,
  };
  const looks: Record<string, Look> = {};
  for (const [name, url] of Object.entries(pages)) looks[name] = await openView(page, url);

  const shared = looks.Collection;
  for (const [name, look] of Object.entries(looks)) {
    expect.soft(look.trigger, `${name}: View button differs from Collection's`).toBe(shared.trigger);
    expect.soft(look.panel, `${name}: View panel differs from Collection's`).toBe(shared.panel);
    expect.soft(look.sizeControl, `${name}: no size control in View`).toBe(true);
  }
});

test("album and trip card sizes persist across a reload", async ({ page }) => {
  for (const url of ["/albums?section=albums", "/albums?section=trips"]) {
    await page.goto(url);
    await page.getByRole("button", { name: VIEW }).click();
    const slider = page.getByRole("slider");
    const before = await slider.inputValue();
    await slider.focus();
    await page.keyboard.press("End");
    const largest = await slider.inputValue();
    expect(largest, url).not.toBe(before);
    await page.reload();
    await page.getByRole("button", { name: VIEW }).click();
    await expect(page.getByRole("slider"), url).toHaveValue(largest);
    // Put it back, so later specs see the usual grid.
    await page.getByRole("slider").fill(before);
    await page.keyboard.press("Escape");
  }
});
