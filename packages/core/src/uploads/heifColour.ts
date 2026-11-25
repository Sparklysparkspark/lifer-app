// The colour space a HEIF or AVIF states for its primary image, and the step that brings decoded
// pixels in it to sRGB. Neither heic-decode nor sharp's AVIF reader applies an nclx box, and
// heic-decode ignores an ICC profile too, so a Display P3 photo (every iPhone's) would come out
// washed out. Config-free, so the inference worker can use it too.
import { open } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import sharp, { type Matrix3x3, type Sharp } from "sharp";

// Linear-light conversions to sRGB primaries, by nclx colour_primaries code (ITU-T H.273).
const TO_SRGB: Record<number, Matrix3x3> = {
  9: [
    [1.660491, -0.5876411, -0.0728499],
    [-0.1245505, 1.1328999, -0.0083494],
    [-0.0181508, -0.1005789, 1.1187297],
  ],
  12: [
    [1.2249401, -0.2249404, 0],
    [-0.0420569, 1.0420571, 0],
    [-0.0196376, -0.0786361, 1.0982735],
  ],
};

// The meta box sits near the start of the file; one bigger than this isn't read for colour.
const MAX_META_BYTES = 4 * 1024 * 1024;

export type HeifColour = { primaries: number } | { icc: Buffer };

interface Box {
  type: string;
  body: number;
  end: number;
}

function boxesIn(b: Buffer, start: number, end: number): Box[] {
  const found: Box[] = [];
  for (let p = start; p + 8 <= end;) {
    let size = b.readUInt32BE(p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(b.readBigUInt64BE(p + 8));
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head || p + size > end) break;
    found.push({ type: b.toString("latin1", p + 4, p + 8), body: p + head, end: p + size });
    p += size;
  }
  return found;
}

/** The colr property of a HEIF's primary image: an ICC profile (preferred when both are there),
 *  else the nclx colour_primaries code. Null when it has neither or can't be read. */
export function heifColour(head: Buffer): HeifColour | null {
  try {
    const meta = boxesIn(head, 0, head.length).find((b) => b.type === "meta");
    if (!meta) return null;
    const inMeta = boxesIn(head, meta.body + 4, meta.end);
    const pitm = inMeta.find((b) => b.type === "pitm");
    const iprp = inMeta.find((b) => b.type === "iprp");
    if (!pitm || !iprp) return null;
    const primary = head[pitm.body] === 0 ? head.readUInt16BE(pitm.body + 4) : head.readUInt32BE(pitm.body + 4);
    const inIprp = boxesIn(head, iprp.body, iprp.end);
    const ipco = inIprp.find((b) => b.type === "ipco");
    if (!ipco) return null;
    const properties = boxesIn(head, ipco.body, ipco.end);
    const indexes: number[] = [];
    for (const ipma of inIprp.filter((b) => b.type === "ipma")) {
      const version = head[ipma.body];
      const wide = (head[ipma.body + 3] & 1) === 1;
      let p = ipma.body + 8;
      for (let n = head.readUInt32BE(ipma.body + 4); n > 0; n--) {
        const item = version < 1 ? head.readUInt16BE(p) : head.readUInt32BE(p);
        p += version < 1 ? 2 : 4;
        for (let k = head[p++]; k > 0; k--) {
          const index = wide ? head.readUInt16BE(p) & 0x7fff : head[p] & 0x7f;
          p += wide ? 2 : 1;
          if (item === primary) indexes.push(index);
        }
      }
    }
    const colr = indexes.map((i) => properties[i - 1]).filter((b) => b?.type === "colr");
    const kind = (b: Box) => head.toString("latin1", b.body, b.body + 4);
    const icc = colr.find((b) => kind(b) === "prof" || kind(b) === "rICC");
    if (icc) return { icc: Buffer.from(head.subarray(icc.body + 4, icc.end)) };
    const nclx = colr.find((b) => kind(b) === "nclx");
    return nclx ? { primaries: head.readUInt16BE(nclx.body + 4) } : null;
  } catch {
    return null;
  }
}

/** heifColour of a file or bytes, reading only the start of a file. */
export async function readHeifColour(input: string | Uint8Array): Promise<HeifColour | null> {
  if (typeof input !== "string") return heifColour(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  const fh = await open(input, "r");
  try {
    const buf = Buffer.alloc(Math.min((await fh.stat()).size, MAX_META_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return heifColour(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** Brings decoded pixels in the stated nclx primaries to sRGB; other primaries pass through.
 *  libvips takes untagged pixels as sRGB, which also undoes the sRGB transfer the nclx states.
 *  shortcut: a primary image in PQ or HLG (no SDR base) isn't tone mapped and looks flat; map it
 *  here if such files turn up. */
export function nclxToSrgb(image: Sharp, primaries: number): Sharp {
  const matrix = TO_SRGB[primaries];
  return matrix ? image.pipelineColourspace("scrgb").recomb(matrix) : image;
}

/** Raw RGBA pixels as a PNG carrying `icc`, so sharp converts them to sRGB when it reads it: sharp
 *  can't assign a profile to pixels without converting them. */
export async function pngWithIcc(
  pixels: Buffer,
  size: { width: number; height: number },
  icc: Buffer,
): Promise<Buffer> {
  const png = await sharp(pixels, { raw: { ...size, channels: 4 }, limitInputPixels: false })
    .png({ compressionLevel: 1 })
    .toBuffer();
  const type = Buffer.from("iCCP", "latin1");
  const data = Buffer.concat([Buffer.from("icc\0\0", "latin1"), deflateSync(icc)]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  // Right after the 8-byte signature and the 25-byte IHDR chunk, where PNG wants it.
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}
