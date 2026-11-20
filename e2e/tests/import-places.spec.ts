// The import screen's "Where": photos grouped by outing, each group with a place chip. One group
// has camera GPS, one gets a saved place, one is left for later and is offered the earlier place.
// Places are only staged here (applied after the import), so nothing is imported.
import type { APIRequestContext } from "@playwright/test";
import { ExifTool } from "exiftool-vendored";
import { makeCameraJpeg } from "../support/photo.js";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, json } from "../support/library.js";
import { expect, test } from "../support/test.js";

const SESSIONS = [
  // Near Vancouver: the zoned instant is 14:00 UTC, but groups follow the camera's 07:00.
  { name: "gps", times: ["07:00", "07:05", "07:10"], gps: { lat: 49.28, lon: -123.12 } },
  { name: "pond", times: ["10:00", "10:05", "10:10"] },
  { name: "later", times: ["14:00", "14:05", "14:10"] },
];
const PLACE = "E2E King Fisher Pond with a long name that has to wrap rather than be cut off at the edge";

// Spots left behind frame the map for later specs and catch their drops (map-placing.spec.ts).
const spots: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of spots.splice(0)) await request.delete(`/api/saved-spots/${id}`, { headers: HEADERS });
});
async function addSpot(request: APIRequestContext, name: string, lat: number, lon: number) {
  const spot = await json<{ id: string }>(
    await request.post("/api/saved-spots", { headers: HEADERS, data: { name, lat, lon } }),
  );
  spots.push(spot.id);
}

test("groups an import by outing and stages a place per group", async ({ page }, testInfo) => {
  await addSpot(page.request, PLACE, 10, 10);
  const files: string[] = [];
  const exiftool = new ExifTool();
  try {
    for (const [s, session] of SESSIONS.entries())
      for (const [i, time] of session.times.entries()) {
        const file = testInfo.outputPath(`${session.name}-${i}.jpg`);
        await makeCameraJpeg(file, { taken: `2018:06:01 ${time}:00`, tint: 40 + s * 30 + i * 7 });
        if (session.gps)
          await exiftool.write(
            file,
            {
              "EXIF:GPSLatitude": session.gps.lat,
              "EXIF:GPSLatitudeRef": "N",
              "EXIF:GPSLongitude": -session.gps.lon,
              "EXIF:GPSLongitudeRef": "W",
            } as never,
            { writeArgs: ["-overwrite_original"] },
          );
        files.push(file);
      }
  } finally {
    await exiftool.end();
  }

  await page.goto("/import");
  await expect(page.getByText("Location", { exact: true })).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("region", { name: "Photos and videos" }).getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles(files);

  const groups = page.getByRole("region", { name: /^Photos from / });
  await expect(groups).toHaveCount(3);
  const [gps, pond, later] = [groups.nth(0), groups.nth(1), groups.nth(2)];
  await expect(gps.getByRole("button", { name: /^From the camera: / })).toBeVisible({ timeout: 20_000 });

  await pond.getByRole("button", { name: "Set place", exact: true }).click();
  await page.getByRole("menuitem", { name: "Choose a place" }).click();
  // The list opens in a popover outside the dialog.
  await page.getByRole("option", { name: new RegExp(PLACE.slice(0, 20)) }).click();
  await expect(pond.getByRole("button", { name: PLACE })).toBeVisible();

  // The later group is left unplaced, and offered the earlier group's place in one click.
  await expect(later.getByRole("button", { name: "Set place", exact: true })).toBeVisible();
  await expect(later.getByRole("button", { name: /^Same place as the / })).toBeVisible();

  for (const [name, size, scheme] of [
    ["light", { width: 1280, height: 900 }, "light"],
    ["dark", { width: 1280, height: 900 }, "dark"],
    ["narrow", { width: 390, height: 844 }, "light"],
    ["wide", { width: 2560, height: 1200 }, "light"],
  ] as const) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: testInfo.outputPath(`import-places-${name}.png`), fullPage: true });
  }
});

test("applies the chosen place once the import finishes, with one Undo", async ({ page }, testInfo) => {
  const name = "E2E Import Applied Pond";
  await addSpot(page.request, name, 11, 11);
  const file = testInfo.outputPath("placed.jpg");
  await makeCameraJpeg(file, { taken: "2019:05:02 09:00:00", tint: 200 });

  await page.goto("/import");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("region", { name: "Photos and videos" }).getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles(file);

  const group = page.getByRole("region", { name: /^Photos from / });
  await group.getByRole("button", { name: "Set place", exact: true }).click();
  await page.getByRole("menuitem", { name: "Choose a place" }).click();
  await page.getByRole("option", { name: new RegExp(name) }).click();
  await expect(group.getByRole("button", { name })).toBeVisible();

  const picker = page.getByRole("combobox", { name: "Type a species…" });
  if (!(await picker.isVisible())) await page.getByRole("button", { name: "Type a species…" }).click();
  await picker.fill("chickadee");
  await page.getByRole("option", { name: new RegExp(SPECIES.chickadee.commonName) }).click();
  await page.getByRole("button", { name: "Import 1 photo" }).click();

  const toast = page.getByRole("status").filter({ hasText: "Place set for 1 photo" });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath("import-places-applied.png") });
  const status = () =>
    page.request.get("/api/captures/location/status", { headers: HEADERS }).then((r) => json<{ canUndo: boolean }>(r));
  expect((await status()).canUndo).toBe(true);
  await toast.locator("..").getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await status()).canUndo).toBe(false);
});
