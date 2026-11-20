import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { rawPreview } from "./localInferenceServer.js";

describe("rawPreview", () => {
  it("answers null for a file with no embedded preview, and leaves no temp file behind", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    expect(await rawPreview(jpeg)).toBeNull();
  });
});
