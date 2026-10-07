import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractVideoFrame, probeVideo } from "./image.js";

const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string;
const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-ffmpeg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeClip(name: string): string {
  const out = path.join(dir, name);
  execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=64x64:rate=10",
    "-c:v",
    "mpeg4",
    out,
  ]);
  return out;
}

describe("ffmpeg input restrictions", () => {
  it("still reads an MP4 clip", async () => {
    const clip = makeClip("ok.mp4");
    const probe = await probeVideo(clip);
    expect(probe.durationSeconds).toBeGreaterThan(1);
    const frame = await extractVideoFrame(clip, 1);
    expect(frame.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("refuses a container outside the MP4 family, even named .mp4", async () => {
    const avi = makeClip("real.avi");
    const disguised = path.join(dir, "disguised.mp4");
    execFileSync("cp", [avi, disguised]);
    await expect(probeVideo(disguised)).rejects.toThrow();
  });
});
