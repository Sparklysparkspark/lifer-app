import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { placementFor, setPlan } from "@lifer/core/species/acceleration.js";
import { preprocessImage } from "@lifer/core/species/onnxImageModel.js";
import { forceFullPrecisionClip, isGrayscaleImage } from "./clipEmbedding.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-clip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A 32x32 gradient, so every pixel differs and a misread channel shows.
function gradient(channels: 1 | 3): Buffer {
  const px = Buffer.alloc(32 * 32 * channels);
  for (let i = 0; i < 32 * 32; i++) for (let c = 0; c < channels; c++) px[i * channels + c] = (i * 7) % 256;
  return px;
}
const png = (channels: 1 | 3) =>
  sharp(gradient(channels), { raw: { width: 32, height: 32, channels } })
    .toColourspace(channels === 1 ? "b-w" : "srgb")
    .png()
    .toBuffer();

describe("CLIP preprocessing for catalog vectors", () => {
  it("gives a grayscale photo the same tensor as its RGB copy", async () => {
    const gray = await png(1);
    expect((await sharp(gray).metadata()).channels).toBe(1);
    const fromGray = await preprocessImage(gray);
    const fromRgb = await preprocessImage(await png(3));
    expect(fromGray.length).toBe(3 * 224 * 224);
    expect(fromGray.every(Number.isFinite)).toBe(true);
    expect(Array.from(fromGray)).toEqual(Array.from(fromRgb));
  });

  it("tells grayscale files from colour ones", async () => {
    const grayPath = path.join(dir, "gray.png");
    const rgbPath = path.join(dir, "rgb.png");
    writeFileSync(grayPath, await png(1));
    writeFileSync(rgbPath, await png(3));
    expect(await isGrayscaleImage(grayPath)).toBe(true);
    expect(await isGrayscaleImage(rgbPath)).toBe(false);
  });
});

describe("forceFullPrecisionClip", () => {
  it("runs the full-precision file on the CPU, where the int8 one runs otherwise", () => {
    const fp32 = path.join(dir, "clip-fp32.onnx");
    writeFileSync(fp32, "");
    setPlan({
      device: null,
      runtime: null,
      placements: { clip: { backend: "cpu", modelPath: fp32, providers: ["cpu"] } },
    });
    expect(placementFor("clip", "int8.onnx").modelPath).toBe("int8.onnx");
    forceFullPrecisionClip(fp32);
    expect(placementFor("clip", "int8.onnx")).toEqual({ modelPath: fp32, providers: ["cpu"] });
  });
});
