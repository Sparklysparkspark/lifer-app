// Sound recordings (N-03): a WAV imported into a trip shows as a recording tile, plays in the
// viewer, and the Gallery's media filter narrows to recordings.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SPECIES } from "../support/fixtureCatalog.js";
import { HEADERS, json, seedTrip, speciesId } from "../support/library.js";
import { expect, test } from "../support/test.js";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;

/** A two second tone, made here so the repo holds no audio fixture. */
function makeWav(file: string, frequency: number): void {
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2`, file], {
    stdio: "ignore",
  });
}

test("imports a recording, plays it and filters the Gallery to recordings", async ({ page }, testInfo) => {
  const trip = await seedTrip(page.request, "E2E Sound recordings", [
    { file: "robin.jpg", species: SPECIES.robin, taken: "2020:06:01 12:00:00", tint: 160 },
  ]);
  const wav = testInfo.outputPath("robin-song.wav");
  makeWav(wav, 523);
  await json(
    await page.request.post("/api/uploads/audio", {
      headers: HEADERS,
      multipart: {
        speciesId: await speciesId(page.request, SPECIES.robin),
        tripId: trip.id,
        file: { name: "robin-song.wav", mimeType: "audio/wav", buffer: readFileSync(wav) },
      },
    }),
  );

  await page.goto(`/gallery?tripId=${trip.id}`);
  const tiles = page.getByTestId("photo-tile");
  // The Gallery shows photos only until the media filter says otherwise.
  await expect(tiles).toHaveCount(1);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const media = page.getByRole("group", { name: "Media type" });
  await media.getByRole("button", { name: "Both" }).click();
  await expect(tiles).toHaveCount(2);
  // Closed by its own button, so the next click reaches the grid.
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(media).toBeHidden();
  const recording = tiles.filter({ hasText: "Sound recording" });
  await expect(recording).toHaveCount(1);
  await expect(recording).toContainText("0:02");

  // The viewer plays it.
  await recording.getByRole("img").first().click();
  const audio = page.locator("audio");
  await expect(audio).toHaveAttribute("src", /\/api\/photos\/[^/]+\/audio$/);
  await audio.evaluate((a: HTMLAudioElement) => a.play());
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  expect(await audio.evaluate((a: HTMLAudioElement) => Math.round(a.duration))).toBe(2);
  await page.getByRole("button", { name: "Close" }).click();

  // The media filter narrows to the recording, then back to both.
  await page.getByRole("button", { name: /^Filters/ }).click();
  await media.getByRole("button", { name: "Recordings" }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText("Sound recording");
  await media.getByRole("button", { name: "Both" }).click();
  await expect(tiles).toHaveCount(2);
});
