// Placing photos on the map (V-13): a session of 20 photos dragged from the Needs placing tray onto
// one point of the map is placed there at once, and the toast's Undo takes it back. Offline place
// search finds wildlife places from the downloaded region pack.
import { SPECIES } from "../support/fixtureCatalog.js";
import { markKnownFailure } from "../support/knownFailures.js";
import { HEADERS, json, seedTrip, type SeedPhoto } from "../support/library.js";
import { expect, test } from "../support/test.js";

test.beforeEach(() => markKnownFailure(test.info()));

const PHOTOS: SeedPhoto[] = Array.from({ length: 20 }, (_, i) => ({
  file: `pond-${String(i).padStart(2, "0")}.jpg`,
  species: SPECIES.moose,
  taken: `2016:09:10 10:${String(i).padStart(2, "0")}:00`,
  tint: 170 + i,
}));

test("drags 20 photos onto the map, then undoes it", async ({ page }) => {
  test.setTimeout(180_000);
  const trip = await seedTrip(page.request, "E2E Map drop", PHOTOS);
  const located = async () => {
    const res = await json<{ items: Array<{ lat: number | null; lon: number | null }> }>(
      await page.request.get(`/api/gallery?tripId=${trip.id}&limit=100`, { headers: HEADERS }),
    );
    return res.items.filter((i) => i.lat !== null && i.lon !== null).length;
  };
  expect(await located()).toBe(0);

  await page.goto(`/gallery?tripId=${trip.id}&view=map&at=tray`);
  const map = page.getByTestId("photo-map");
  await expect(map).toBeVisible();
  const group = page.getByTestId("placing-group").filter({ hasText: "20 photos" });
  await expect(group).toHaveCount(1);

  const box = (await map.boundingBox())!;
  await group.dragTo(map, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast.getByText("Placed 20 photos")).toBeVisible();
  await expect.poll(located).toBe(20);
  await expect(page.getByTestId("placing-group")).toHaveCount(0);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(located).toBe(0);
  await expect(page.getByTestId("placing-group").filter({ hasText: "20 photos" })).toHaveCount(1);
});

test("finds a park from the region pack in offline place search", async ({ page }) => {
  await page.goto("/gallery?view=map");
  const search = page.getByRole("combobox", { name: "Search a saved spot, country or province" });
  await search.fill("Burnaby Lake");
  await expect(page.getByRole("option", { name: /^Burnaby Lake Regional Park Park,/ })).toBeVisible();
});
