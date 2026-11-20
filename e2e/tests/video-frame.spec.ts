// Save a video frame as a photo (N-06): from the viewer, the frame the video stands on becomes a new
// photo in the same trip, with the video's species, at the video's own pixel size.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, json, seedTrip, speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;

test("saves the frame the video is paused on as a photo", async ({ page }, testInfo) => {
  const trip = await seedTrip(page.request, "E2E Video frame", [
    { file: "moose-still.jpg", species: SPECIES.moose, taken: "2020:07:01 12:00:00", tint: 161 },
  ]);
  // Made here so the repo holds no video fixture.
  const clip = testInfo.outputPath("moose.mp4");
  execFileSync(
    ffmpeg,
    ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=10", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
  await json(
    await page.request.post("/api/uploads/video", {
      headers: HEADERS,
      multipart: {
        speciesId: await speciesId(page.request, SPECIES.moose),
        tripId: trip.id,
        file: { name: "moose.mp4", mimeType: "video/mp4", buffer: readFileSync(clip) },
      },
    }),
  );

  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  // The Gallery shows photos only until the media filter says otherwise.
  await expect(tiles).toHaveCount(1);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("group", { name: "Media type" }).getByRole("button", { name: "Both" }).click();
  await expect(tiles).toHaveCount(2);
  // Closed by its own button, so the next click reaches the grid.
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByRole("group", { name: "Media type" })).toBeHidden();
  // By keyboard: hovering a video tile swaps its picture and duration for a playing preview.
  const clipTile = await tiles.filter({ hasText: "0:03" }).getByRole("button").first().elementHandle();
  await clipTile!.focus();
  await page.keyboard.press("Enter");

  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1.5;
  });
  const saved = page.waitForResponse((res) => res.url().endsWith("/frame") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Save frame at 0:01.50 as a photo" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Frame saved as a photo")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // A new photo in the trip, filed under the video's species, as large as the video.
  await expect(tiles).toHaveCount(3);
  const items = await json<{ items: Array<{ photoId: string; kind: string; speciesId: string | null }> }>(
    await page.request.get(`/api/gallery?tripId=${trip.id}`, { headers: HEADERS }),
  );
  const moose = await speciesId(page.request, SPECIES.moose);
  const frames = items.items.filter((i) => i.kind !== "video" && i.speciesId === moose);
  expect(frames).toHaveLength(2);
  const sizes = await Promise.all(
    frames.map(async (f) => {
      const res = await page.request.get(`/api/photos/${f.photoId}/original`, { headers: HEADERS });
      return res.ok() ? sharp(await res.body()).metadata() : null;
    }),
  );
  expect(sizes.some((m) => m?.width === 640 && m?.height === 360)).toBe(true);
});
