// CI runs this on macOS, Windows and Linux: the tools Lifer bundles must start on each of them.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { exiftool } from "exiftool-vendored";
import { afterAll, describe, expect, it } from "vitest";

describe("bundled tools", () => {
  afterAll(() => exiftool.end());

  it("ffmpeg starts and reports a version", () => {
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    expect(execFileSync(ffmpeg, ["-version"]).toString()).toMatch(/^ffmpeg version \S+/);
  });

  it("exiftool starts and reports a version", async () => {
    expect(await exiftool.version()).toMatch(/^\d+\.\d+/);
  });
});
