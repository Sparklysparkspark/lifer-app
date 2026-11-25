// The HDR rendition: one Ultra HDR JPEG, up to 2,560 px, made from any HDR original detect.ts
// finds. Every engine that can show HDR reads it, and any other shows its SDR base. It carries no
// metadata (GPS included), only colour. Nothing else in Lifer reads it.
import { readFile } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { decodeJxl } from "@lifer/core/uploads/jxl.js";
import { HLG, PQ, pngCicp, type HdrSource } from "./detect.js";
import { parseGainMapMetadata, type GainMapMetadata } from "./gainMapMetadata.js";
import { readHeif, nclx, withPrimary } from "./heifItems.js";
import { writeUltraHdr } from "./ultraHdr.js";

export const HDR_SIDE = 2560;
const QUALITY = 85;
// HDR signals are scaled so SDR white (ITU-R BT.2408 reference white) is 1.
const SDR_WHITE_NITS = 203;
// Below this many stops of headroom there is nothing an HDR screen would show differently.
const MIN_HEADROOM = 0.15;
const OFFSET = 1 / 64;
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
});

// shortcut: sharp 0.35's typings miss its experimental gain map method; drop once it's typed.
type GainMapSharp = Sharp & { keepGainMap(): Sharp };

interface Raw {
  data: Uint16Array;
  width: number;
  height: number;
}

/** 16-bit RGB pixels exactly as stored (no ICC conversion), upright, fitted inside `size`. */
async function raw16(
  input: string | Buffer,
  size: { width: number; height: number; fit: "inside" | "fill" },
): Promise<Raw> {
  const { data, info } = await sharp(input, originalSharpOptions())
    .rotate()
    .keepIccProfile()
    .resize({ ...size, withoutEnlargement: size.fit === "inside" })
    .removeAlpha()
    .toColourspace("rgb16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint16Array(data.buffer, data.byteOffset, data.length / 2),
    width: info.width,
    height: info.height,
  };
}

const FIT = { width: HDR_SIDE, height: HDR_SIDE, fit: "inside" } as const;

// Linear-light RGB to Display P3, by ITU-T H.273 colour primaries code.
const TO_P3: Record<number, number[]> = {
  1: [0.8224621, 0.177538, 0, 0.0331941, 0.9668058, 0, 0.0170827, 0.0723974, 0.9105199],
  9: [1.3435783, -0.2821797, -0.0613986, -0.0652975, 1.0757879, -0.0104905, 0.0028218, -0.0195985, 1.0167767],
  11: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  12: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

let p3Icc: Promise<Buffer> | null = null;
/** libvips' own Display P3 profile, to tag a base that is P3. */
function displayP3Icc(): Promise<Buffer> {
  return (p3Icc ??= sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } })
    .withIccProfile("p3")
    .png()
    .toBuffer()
    .then(async (png) => (await sharp(png).metadata()).icc!));
}

/** A PQ or HLG signal (0 to 65535) to linear light where SDR white is 1. */
function signalToLinear(transfer: number): Float32Array {
  const lut = new Float32Array(65536);
  if (transfer === PQ) {
    const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875];
    for (let i = 0; i < 65536; i++) {
      const e = Math.pow(i / 65535, 1 / m2);
      lut[i] = (Math.pow(Math.max(e - c1, 0) / (c2 - c3 * e), 1 / m1) * 10000) / SDR_WHITE_NITS;
    }
  } else {
    // HLG inverse OETF to scene light; the OOTF (system gamma) is applied per pixel below.
    const [a, b, c] = [0.17883277, 0.28466892, 0.55991073];
    for (let i = 0; i < 65536; i++) {
      const e = i / 65535;
      lut[i] = e <= 0.5 ? (e * e) / 3 : (Math.exp((e - c) / a) + b) / 12;
    }
  }
  return lut;
}

/** HDR linear Display P3 (SDR white = 1) to an Ultra HDR JPEG: a tone mapped SDR base and the
 *  gain map back to the HDR image. Null when the image has no highlights above SDR white. */
async function fromLinear(hdr: Float32Array, width: number, height: number): Promise<Buffer | null> {
  const pixels = width * height;
  const base = Buffer.alloc(pixels * 3);
  const gains = new Float32Array(pixels * 3);
  let lo = Infinity;
  let hi = -Infinity;
  const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const k = 0.8;
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    // A shoulder above 0.8 that keeps hue: the brightest channel sets one scale for all three.
    const m = Math.max(hdr[i]!, hdr[i + 1]!, hdr[i + 2]!, 0);
    const scale = m <= k ? 1 : (k + (1 - k) * (1 - Math.exp(-(m - k) / (1 - k)))) / m;
    for (let c = i; c < i + 3; c++) {
      const h = Math.max(hdr[c]!, 0);
      const quantised = Math.round(encode(Math.min(h * scale, 1)) * 255);
      base[c] = quantised;
      const gain = Math.log2((h + OFFSET) / (SRGB_TO_LINEAR[quantised]! + OFFSET));
      gains[c] = gain;
      if (gain < lo) lo = gain;
      if (gain > hi) hi = gain;
    }
  }
  if (!(hi > MIN_HEADROOM)) return null;
  lo = Math.min(lo, 0);
  const span = hi - lo;
  const map = Buffer.alloc(pixels * 3);
  for (let i = 0; i < map.length; i++) map[i] = Math.round(((gains[i]! - lo) / span) * 255);
  const meta: GainMapMetadata = {
    baseHeadroom: 0,
    alternateHeadroom: hi,
    useBaseColourSpace: true,
    // One entry per channel of the three-channel map, all alike.
    channels: Array.from({ length: 3 }, () => ({
      min: lo,
      max: hi,
      gamma: 1,
      baseOffset: OFFSET,
      alternateOffset: OFFSET,
    })),
  };
  const raw = { width, height, channels: 3 } as const;
  const [baseJpeg, mapJpeg] = await Promise.all([
    sharp(base, { raw }).jpeg({ quality: QUALITY }).toBuffer(),
    // Half size is plenty for a gain map, which varies slowly.
    sharp(map, { raw })
      .resize({ width: Math.max(1, Math.round(width / 2)) })
      .jpeg({ quality: QUALITY })
      .toBuffer(),
  ]);
  return writeUltraHdr(baseJpeg, mapJpeg, meta, await displayP3Icc());
}

/** A PQ or HLG image's 16-bit pixels to an Ultra HDR JPEG. */
async function fromSignal(px: Raw, transfer: number, primaries: number): Promise<Buffer | null> {
  const matrix = TO_P3[primaries];
  if (!matrix) return null;
  const lut = signalToLinear(transfer);
  const out = new Float32Array(px.width * px.height * 3);
  for (let i = 0; i < out.length; i += 3) {
    let r = lut[px.data[i]!]!;
    let g = lut[px.data[i + 1]!]!;
    let b = lut[px.data[i + 2]!]!;
    if (transfer === HLG) {
      // BT.2100 OOTF for a 1,000 nit display (system gamma 1.2), in nits over SDR white.
      const ys = 0.2627 * r + 0.678 * g + 0.0593 * b;
      const gain = (1000 * Math.pow(ys, 0.2)) / SDR_WHITE_NITS;
      r *= gain;
      g *= gain;
      b *= gain;
    }
    out[i] = matrix[0]! * r + matrix[1]! * g + matrix[2]! * b;
    out[i + 1] = matrix[3]! * r + matrix[4]! * g + matrix[5]! * b;
    out[i + 2] = matrix[6]! * r + matrix[7]! * g + matrix[8]! * b;
  }
  return fromLinear(out, px.width, px.height);
}

/** An SDR base and a gain map image with their ISO 21496-1 metadata, re-encoded at rendition size. */
async function fromGainMap(
  base: string | Buffer,
  gainMap: string | Buffer,
  meta: GainMapMetadata | null,
  primaries: number | null,
): Promise<Buffer | null> {
  // A base that is itself HDR (gain map toward SDR) isn't made into a rendition.
  if (!meta || meta.baseHeadroom > meta.alternateHeadroom) return null;
  if (primaries !== null && primaries !== 1 && primaries !== 2 && !TO_P3[primaries]) return null;
  const px = await raw16(base, FIT);
  const map = await raw16(gainMap, {
    width: Math.max(1, Math.round(px.width / 2)),
    height: Math.max(1, Math.round(px.height / 2)),
    fit: "fill",
  });
  const to8 = (r: Raw) =>
    sharp(Buffer.from(r.data.map((v) => v >> 8)), { raw: { width: r.width, height: r.height, channels: 3 } })
      .jpeg({ quality: QUALITY })
      .toBuffer();
  const [baseJpeg, mapJpeg] = await Promise.all([to8(px), to8(map)]);
  const p3 = primaries === 11 || primaries === 12;
  return writeUltraHdr(baseJpeg, mapJpeg, meta, p3 ? await displayP3Icc() : undefined);
}

async function fromAvifGainMap(file: string): Promise<Buffer | null> {
  const buf = await readFile(file);
  const heif = readHeif(buf);
  const tmap = heif && [...heif.items.values()].find((i) => i.type === "tmap");
  const ref = tmap && heif.refs.find((r) => r.type === "dimg" && r.from === tmap.id);
  const gainId = ref?.to[1];
  const data = tmap && heif.data(tmap.id);
  // The tmap item is a version byte (0), then the ISO 21496-1 block.
  if (!heif || !ref || gainId === undefined || !data || data[0] !== 0) return null;
  if (heif.items.get(gainId)?.type !== "av01") return null;
  const base = heif.items.get(heif.primary);
  return fromGainMap(
    buf,
    withPrimary(buf, heif, gainId),
    parseGainMapMetadata(data.subarray(1)),
    nclx(base)?.primaries ?? 1,
  );
}

async function fromJxl(file: string, source: HdrSource): Promise<Buffer | null> {
  const bytes = await readFile(file);
  const png = await decodeJxl(bytes, { ownColours: true });
  const colour = pngCicp(png);
  if (source.kind !== "gainMap") {
    return colour && (colour.transfer === PQ || colour.transfer === HLG)
      ? fromSignal(await raw16(png, FIT), colour.transfer, colour.primaries)
      : null;
  }
  const box = jhgm(bytes);
  if (!box || (colour && colour.transfer !== 13 && colour.transfer !== 1)) return null;
  return fromGainMap(png, await decodeJxl(box.codestream, { ownColours: true }), box.meta, colour?.primaries ?? 1);
}

/** The 'jhgm' box: version, ISO 21496-1 block, colour encoding, ICC, then the gain map codestream. */
function jhgm(buf: Buffer): { meta: GainMapMetadata | null; codestream: Buffer } | null {
  let at = 0;
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      body += 8;
    } else if (size === 0) size = buf.length - at;
    if (size < 8) return null;
    if (buf.toString("latin1", at + 4, at + 8) === "jhgm" && buf[body] === 0) {
      let p = body + 1;
      const metaSize = buf.readUInt16BE(p);
      const meta = parseGainMapMetadata(buf.subarray(p + 2, p + 2 + metaSize));
      p += 2 + metaSize;
      p += 1 + buf[p]!;
      p += 4 + buf.readUInt32BE(p);
      return { meta, codestream: buf.subarray(p, at + size) };
    }
    at += size;
  }
  return null;
}

/** Makes the rendition's bytes; null when the file turns out to have no HDR to show. */
export async function renderHdr(file: string, source: HdrSource): Promise<Buffer | null> {
  switch (source.kind) {
    case "jxl":
      return fromJxl(file, source);
    case "signal":
      return fromSignal(await raw16(file, FIT), source.transfer, source.primaries);
    case "gainMap":
      if (source.container === "jxl") return fromJxl(file, source);
      if (source.container === "avif") return fromAvifGainMap(file);
      if (!(await sharp(file, originalSharpOptions()).metadata()).gainMap) return null;
      return (sharp(file, originalSharpOptions()).rotate() as GainMapSharp)
        .keepGainMap()
        .resize({ ...FIT, withoutEnlargement: true })
        .jpeg({ quality: QUALITY })
        .toBuffer();
  }
}
