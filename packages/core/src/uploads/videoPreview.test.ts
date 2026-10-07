// Runs the real ffmpeg: a 10-bit source must still get a preview browsers can play (8-bit 4:2:0,
// so H.264 High rather than High 10).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-video-preview-"));
  process.env.APP_DATA_DIR = path.join(dir, "app-data");
  vi.resetModules();
});

afterAll(() => {
  delete process.env.APP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function describeVideo(file: string): string {
  try {
    execFileSync(ffmpeg, ["-hide_banner", "-i", file], { stdio: "pipe" });
  } catch (err) {
    return String((err as { stderr: Buffer }).stderr);
  }
  return "";
}

describe("generateVideoDerivatives", () => {
  it("makes an 8-bit H.264 preview from a 10-bit source", async () => {
    const source = path.join(dir, "ten-bit.mp4");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p10le",
      "-c:a",
      "aac",
      source,
    ]);
    expect(describeVideo(source)).toContain("High 10");

    const { generateVideoDerivatives } = await import("./image.js");
    const result = await generateVideoDerivatives(source, "ten-bit");

    expect(result.previewPath).toBeTruthy();
    const preview = describeVideo(result.previewPath!);
    expect(preview).toMatch(/h264 \(High\)/);
    expect(preview).toContain("yuv420p(");
  }, 30_000);
});
