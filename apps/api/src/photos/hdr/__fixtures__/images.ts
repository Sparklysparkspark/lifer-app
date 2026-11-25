// Synthetic HDR test images: a grey ramp from black to `peakNits`, left to right.
import { deflateSync } from "node:zlib";
import sharp from "sharp";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The PNG with a chunk added just before its image data. */
export function withPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const at = png.indexOf("IDAT") - 4;
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)]);
}

const pqEncode = (nits: number) => {
  const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875];
  const y = Math.pow(Math.min(nits, 10000) / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
};
const hlgEncode = (scene: number) => {
  const [a, b, c] = [0.17883277, 0.28466892, 0.55991073];
  return scene <= 1 / 12 ? Math.sqrt(3 * scene) : a * Math.log(12 * scene - b) + c;
};

/** A 16-bit BT.2020 PQ or HLG PNG, its transfer stated in a cICP chunk (`icc` adds the same as an
 *  ICC profile's cicp tag instead). */
export async function hdrPng(
  transfer: "pq" | "hlg",
  { width = 64, height = 16, peakNits = 1000, cicpIn = "chunk" as "chunk" | "icc" } = {},
): Promise<Buffer> {
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nits = (peakNits * x) / (width - 1);
      // HLG scene light: a 1,000 nit display shows 1.0 at 1,000 nits (system gamma 1.2 on grey).
      const v = transfer === "pq" ? pqEncode(nits) : hlgEncode(Math.pow(nits / 1000, 1 / 1.2));
      const level = Math.round(v * 65535);
      data.fill(level, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  // A Uint16Array input is what makes sharp read 16-bit raw pixels.
  const png = await sharp(data, { raw: { width, height, channels: 3 } })
    .toColourspace("rgb16")
    .png()
    .toBuffer();
  const code = transfer === "pq" ? 16 : 18;
  if (cicpIn === "chunk") return withPngChunk(png, "cICP", Buffer.from([9, code, 0, 1]));
  return withPngChunk(
    png,
    "iCCP",
    Buffer.concat([Buffer.from("HDR\0\0", "latin1"), deflateSync(iccWithCicp(9, code))]),
  );
}

/** A minimal ICC v4.4 profile holding only a cicp tag. */
export function iccWithCicp(primaries: number, transfer: number): Buffer {
  const icc = Buffer.alloc(128 + 4 + 12 + 12);
  icc.writeUInt32BE(icc.length, 0);
  icc.writeUInt32BE(0x04400000, 8);
  icc.write("mntrRGB XYZ ", 12, "latin1");
  icc.write("acsp", 36, "latin1");
  icc.writeUInt32BE(1, 128);
  icc.write("cicp", 132, "latin1");
  icc.writeUInt32BE(144, 136);
  icc.writeUInt32BE(12, 140);
  icc.write("cicp", 144, "latin1");
  icc.writeUInt8(primaries, 152);
  icc.writeUInt8(transfer, 153);
  icc.writeUInt8(0, 154);
  icc.writeUInt8(1, 155);
  return icc;
}

/** An SDR 8-bit sRGB PNG of the same ramp, peak at SDR white. */
export function sdrPng(width = 64, height = 16): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) data.fill(Math.round((255 * (i % width)) / (width - 1)), i * 3, i * 3 + 3);
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** The ISO 21496-1 block in a JPEG's APP2 segments, if any. */
export function isoBlock(jpeg: Buffer): Buffer | null {
  let at = 2;
  while (jpeg[at] === 0xff && jpeg[at + 1] !== 0xda) {
    const length = jpeg.readUInt16BE(at + 2);
    const payload = jpeg.subarray(at + 4, at + 2 + length);
    if (jpeg[at + 1] === 0xe2 && payload.toString("latin1", 0, 27) === "urn:iso:std:iso:ts:21496:-1")
      return payload.subarray(28);
    at += 2 + length;
  }
  return null;
}
