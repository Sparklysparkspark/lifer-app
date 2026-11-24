// Damaged files must fail as ordinary errors, never take the process down with them.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-corrupt-images-"));
// Derivatives go under APP_DATA_DIR, which is read when the module loads.
process.env.APP_DATA_DIR = dir;
const { generateDerivatives } = await import("./image.js");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4a7" } })
  .withExif({ IFD0: { Make: "Lifer", Model: "Test" } })
  .jpeg()
  .toBuffer();
const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4a7" } })
  .png()
  .toBuffer();

/** The PNG with its IHDR size rewritten and its checksum fixed, so only the size is wrong. */
function pngSized(width: number, height: number): Buffer {
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

const noise = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) & 0xff));
const corruptJpeg = Buffer.concat([jpeg.subarray(0, 64), noise(jpeg.length - 64)]);

const FIXTURES: Record<string, Buffer> = {
  "zero-bytes.jpg": Buffer.alloc(0),
  "text.jpg": Buffer.from("This is a text file with a photo's name.\n"),
  "random.jpg": noise(4096),
  "corrupt.jpg": corruptJpeg,
  "truncated.jpg": jpeg.subarray(0, Math.floor(jpeg.length * 0.4)),
  "bogus-header.png": Buffer.concat([png.subarray(0, 12), noise(png.length - 12)]),
  "huge.png": pngSized(100_000, 100_000),
  "zero-size.png": pngSized(0, 0),
};
for (const [name, bytes] of Object.entries(FIXTURES)) writeFileSync(path.join(dir, name), bytes);

describe("generateDerivatives on damaged files", () => {
  it.each(Object.keys(FIXTURES))("rejects %s from its path and its bytes", async (name) => {
    await expect(generateDerivatives(path.join(dir, name), `p-${name}`)).rejects.toThrow();
    await expect(generateDerivatives(FIXTURES[name], `b-${name}`)).rejects.toThrow();
  });

  it("survives many at once, as an import runs them, and still reads a good photo after", async () => {
    const names = Object.keys(FIXTURES);
    for (let round = 0; round < 10; round++) {
      const results = await Promise.allSettled(
        names.map((n) => generateDerivatives(path.join(dir, n), `r${round}-${n}`)),
      );
      expect(results.every((r) => r.status === "rejected")).toBe(true);
    }
    const good = path.join(dir, "good.jpg");
    writeFileSync(good, jpeg);
    await expect(generateDerivatives(good, "good")).resolves.toMatchObject({ width: 64, height: 48 });
  });
});
