// Previews and matching must show a wide-gamut photo in its real colours, whatever its format.
// The fixtures are one picture: a Display P3 JPEG (ICC profile, which sharp converts itself), a
// HEIC with the same profile (as iPhones save), a 10-bit AVIF stating P3 primaries in nclx, and
// JPEG XL files in P3.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { decodedJpegBuffer } from "./decodedJpeg.js";
import type { PhotoFormat } from "./formats.js";
import { heifColour } from "./heifColour.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-colour-"));
// Derivatives go under APP_DATA_DIR, which is read when the module loads.
process.env.APP_DATA_DIR = dir;
const { generateDerivatives } = await import("./image.js");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) => path.join(import.meta.dirname, "__fixtures__", name);

async function pixels(input: string | Buffer): Promise<Buffer> {
  return sharp(input).resize(200, 133, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
}

/** Mean of max minus min channel: how colourful the picture is. */
function chroma(p: Buffer): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 3) sum += Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]);
  return sum / (p.length / 3);
}

// Read as if they were sRGB, P3 colours lose about a sixth of their saturation (a ratio near 0.84);
// a correct render keeps it, give or take what lossy encoding costs a 200 px picture.
const KEPT = 0.93;

const reference = await pixels(fixture("p3.jpg"));

describe("wide-gamut colour", () => {
  it("reads the colour space a HEIF or AVIF states for its primary image", async () => {
    expect(heifColour(readFileSync(fixture("p3.avif")))).toEqual({ primaries: 12 });
    const icc = heifColour(readFileSync(fixture("p3.heic")));
    expect(icc && "icc" in icc && icc.icc.toString("latin1", 36, 40)).toBe("acsp");
    const srgb = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#4a7" } })
      .avif()
      .toBuffer();
    expect([{ primaries: 1 }, { primaries: 2 }, null]).toContainEqual(heifColour(srgb));
    expect(heifColour(Buffer.from("not an avif at all"))).toBeNull();
    expect(heifColour(readFileSync(fixture("p3.avif")).subarray(0, 200))).toBeNull();
  });

  it.each([
    ["p3.avif", "avif"],
    ["p3.heic", "heic"],
    ["tiny.jxl", "jxl"],
    ["tiny-bare.jxl", "jxl"],
  ] as [string, PhotoFormat][])("decodes %s to sRGB, as saturated as the P3 JPEG", async (name, format) => {
    const decoded = await pixels(await decodedJpegBuffer(format, fixture(name)));
    expect(chroma(decoded) / chroma(reference)).toBeGreaterThan(KEPT);
    expect(chroma(decoded) / chroma(reference)).toBeLessThan(1.05);
  });

  it("makes an AVIF's previews in its real colours", async () => {
    const { displayPath, thumbPath } = await generateDerivatives(fixture("p3.avif"), "p3-avif");
    for (const out of [displayPath, thumbPath])
      expect(chroma(await pixels(out)) / chroma(reference)).toBeGreaterThan(KEPT);
    const unconverted = await pixels(await sharp(fixture("p3.avif")).jpeg().toBuffer());
    expect(chroma(unconverted) / chroma(reference)).toBeLessThan(0.88);
  });

  it("converts a P3 JPEG's previews to sRGB rather than dropping its profile", async () => {
    const { displayPath } = await generateDerivatives(fixture("p3.jpg"), "p3-jpg");
    const stripped = await pixels(await sharp(fixture("p3.jpg"), { ignoreIcc: true }).toBuffer());
    expect(chroma(await pixels(displayPath)) / chroma(reference)).toBeGreaterThan(KEPT);
    expect(chroma(stripped) / chroma(reference)).toBeLessThan(0.88);
  });
});
