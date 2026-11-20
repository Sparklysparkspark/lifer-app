import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string;
const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-audio-derivs-"));
// Derivatives go under APP_DATA_DIR, which is read when the module loads.
process.env.APP_DATA_DIR = dir;
const { generateAudioDerivatives, parseAudioDuration } = await import("./image.js");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseAudioDuration", () => {
  it("reads the duration of an input description", () => {
    expect(parseAudioDuration("Input #0, wav, from 'a.wav':\n  Duration: 00:01:02.50, bitrate: 1 kb/s")).toBe(62.5);
  });
  it("is null for a zero or missing duration and throws on non-media", () => {
    expect(parseAudioDuration("Input #0, wav, from 'a.wav':\n  Duration: N/A")).toBeNull();
    expect(() => parseAudioDuration("a.wav: Invalid data found")).toThrow();
  });
});

describe("generateAudioDerivatives", () => {
  it("draws a waveform and reads the duration", async () => {
    const wav = path.join(dir, "tone.wav");
    execFileSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav], { stdio: "ignore" });
    const out = await generateAudioDerivatives(wav, "photo-1");
    expect(out.durationSeconds).toBeGreaterThan(1.5);
    expect(existsSync(out.displayPath) && existsSync(out.thumbPath)).toBe(true);
    expect(out.width).toBeGreaterThan(0);
  });

  it("refuses a container that isn't audio, even named .wav", async () => {
    const avi = path.join(dir, "real.avi");
    execFileSync(
      ffmpegPath,
      ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=10", "-c:v", "mpeg4", avi],
      {
        stdio: "ignore",
      },
    );
    const disguised = path.join(dir, "disguised.wav");
    execFileSync("cp", [avi, disguised]);
    await expect(generateAudioDerivatives(disguised, "photo-2")).rejects.toThrow();
  });
});
