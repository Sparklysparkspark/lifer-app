// Journey (T-02): a smart album and a pinned filter both built on a tag, then the tag deleted.
// Neither may blank a page or show an error; both just match nothing (remembered-state.md).
import { SPECIES } from "../../support/fixtureCatalog.js";
import { markKnownFailure } from "../../support/knownFailures.js";
import { HEADERS, json, seedTrip } from "../../support/library.js";
import { expect, test } from "../../support/test.js";

const TAG = "e2e-journey-tag";
const ALBUM = "E2E Journey Smart";
const PIN = "E2E journey pin";
const PIN_ID = "e2e-journey";

test.beforeEach(() => markKnownFailure(test.info()));

// Later specs list every pin and album, so this one's go.
test.afterEach(async ({ request }) => {
  const { pins } = await json<{ pins: Array<{ id: string }> }>(
    await request.get("/api/pinned-filters", { headers: HEADERS }),
  );
  await json(
    await request.put("/api/pinned-filters", {
      headers: HEADERS,
      data: { pins: pins.filter((p) => p.id !== PIN_ID) },
    }),
  );
  const { albums } = await json<{ albums: Array<{ id: string; name: string }> }>(
    await request.get("/api/albums", { headers: HEADERS }),
  );
  for (const album of albums.filter((a) => a.name === ALBUM))
    await json(await request.delete(`/api/albums/${album.id}`, { headers: HEADERS }));
});

test("a smart album and a pin on a tag survive the tag being deleted", async ({ page }) => {
  const request = page.request;
  const trip = await seedTrip(request, "E2E Journey Tag", [
    { file: "tagged.jpg", species: SPECIES.moose, taken: "2019:08:01 12:00:00", tint: 182 },
  ]);
  await json(
    await request.patch("/api/captures/tags", {
      headers: HEADERS,
      data: { captureIds: [trip.captureIds["tagged.jpg"]], tags: [TAG] },
    }),
  );
  const rules = { version: 2, query: { tag: [TAG] } };
  const album = await json<{ id: string }>(
    await request.post("/api/albums", { headers: HEADERS, data: { name: ALBUM, rules } }),
  );
  const { pins } = await json<{ pins: unknown[] }>(await request.get("/api/pinned-filters", { headers: HEADERS }));
  await json(
    await request.put("/api/pinned-filters", {
      headers: HEADERS,
      data: { pins: [...pins, { id: PIN_ID, name: PIN, rules }] },
    }),
  );

  const tiles = page.getByTestId("photo-tile");
  await page.goto(`/albums/${album.id}`);
  await expect(page.getByRole("heading", { level: 1, name: ALBUM })).toBeVisible();
  await expect(tiles).toHaveCount(1);

  // Delete the tag from Manage tags.
  await page.goto("/tags");
  const row = page.getByRole("listitem").filter({ hasText: TAG });
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete tag" }).click();
  await expect(row).toHaveCount(0);

  // The album still opens, now empty.
  await page.goto(`/albums/${album.id}`);
  await expect(page.getByRole("heading", { level: 1, name: ALBUM })).toBeVisible();
  await expect(tiles).toHaveCount(0);

  // The pin is still offered and applies cleanly, matching nothing.
  await page.goto("/gallery");
  const pin = page.getByRole("group", { name: "Pinned filters" }).getByRole("button", { name: PIN });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(tiles).toHaveCount(0);

  // Back leaves the pin's filter, and the Gallery has its photos again.
  await page.goBack();
  await expect(tiles.first()).toBeVisible();
});
