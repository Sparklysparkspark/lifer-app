// Whether a photo's original holds HDR, read from the file itself: a gain map (JPEG, AVIF, JPEG XL)
// or a PQ or HLG transfer (AVIF, PNG, TIFF, JPEG XL). Only the HDR rendition reads this; previews,
// matching and every other step decode the file as before.
import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { readHeif, nclx } from "./heifItems.js";

export const PQ = 16;
export const HLG = 18;

export type HdrSource =
  | { kind: "gainMap"; container: "jpeg" | "avif" | "jxl" }
  | { kind: "signal"; container: "avif" | "png" | "tiff"; transfer: number; primaries: number }
  /** A JPEG XL without a gain map: its colour is known only once decoded (render.ts). */
  | { kind: "jxl" };

// Headers usually fit the first 64 KB; a long XMP or meta box gets one more, larger read.
const HEAD_SIZES = [64 * 1024, 1024 * 1024];
const MORE = Symbol("read more");

async function head(file: string, bytes: number): Promise<Buffer> {
  const fd = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/** The ICC tag 'cicp' (ICC v4.4), as ITU-T H.273 codes. */
export function iccCicp(icc: Buffer | undefined): { primaries: number; transfer: number } | null {
  if (!icc || icc.length < 132) return null;
  const count = icc.readUInt32BE(128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
    const at = 132 + i * 12;
    if (icc.toString("latin1", at, at + 4) !== "cicp") continue;
    const offset = icc.readUInt32BE(at + 4);
    if (offset + 12 > icc.length || icc.toString("latin1", offset, offset + 4) !== "cicp") return null;
    return { primaries: icc[offset + 8]!, transfer: icc[offset + 9]! };
  }
  return null;
}

/** A PNG's cICP chunk, or the cicp tag of its ICC profile; read before the image data. */
export function pngCicp(buf: Buffer): { primaries: number; transfer: number } | null {
  let at = 8;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "cICP" && length >= 2) return { primaries: data[0]!, transfer: data[1]! };
    if (type === "iCCP") {
      const nul = data.indexOf(0);
      try {
        const found = iccCicp(inflateSync(data.subarray(nul + 2)));
        if (found) return found;
      } catch {
        // a damaged profile: no colour from it
      }
    }
    if (type === "IDAT") return null;
    at += 12 + length;
  }
  return null;
}

// Ultra HDR and ISO 21496-1 JPEGs say so in the primary image's own APP segments. Null when the
// segments run past the bytes read.
function jpegHasGainMap(buf: Buffer): boolean | null {
  let at = 2;
  let mpf = false;
  let gainMap = false;
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1]!;
    if (marker === 0xda || marker === 0xd9) return mpf && gainMap;
    const length = buf.readUInt16BE(at + 2);
    const payload = buf.subarray(at + 4, at + 2 + length);
    if (marker === 0xe2 && payload.toString("latin1", 0, 4) === "MPF\0") mpf = true;
    if (marker === 0xe2 && payload.toString("latin1", 0, 27) === "urn:iso:std:iso:ts:21496:-1") gainMap = true;
    if (marker === 0xe1 && payload.includes("hdr-gain-map/1.0/")) gainMap = true;
    at += 2 + length;
  }
  return at + 4 > buf.length ? null : mpf && gainMap;
}

function hdrTransfer(colour: { primaries: number; transfer: number } | null) {
  return colour && (colour.transfer === PQ || colour.transfer === HLG) ? colour : null;
}

/** The HDR this file holds, or null for SDR, a format without an HDR rendition, or an unreadable file. */
export async function detectHdr(file: string): Promise<HdrSource | null> {
  for (const size of HEAD_SIZES) {
    const buf = await head(file, size).catch(() => null);
    if (!buf || buf.length < 16) return null;
    const found = await detectIn(file, buf, buf.length === size && size !== HEAD_SIZES.at(-1));
    if (found !== MORE) return found;
  }
  return null;
}

async function detectIn(file: string, buf: Buffer, more: boolean): Promise<HdrSource | null | typeof MORE> {
  if (buf.readUInt16BE(0) === 0xffd8) {
    const gainMap = jpegHasGainMap(buf);
    if (gainMap === null && more) return MORE;
    return gainMap ? { kind: "gainMap", container: "jpeg" } : null;
  }
  if (buf.toString("latin1", 1, 4) === "PNG") {
    if (more && !buf.includes("IDAT")) return MORE;
    const colour = hdrTransfer(pngCicp(buf));
    return colour ? { kind: "signal", container: "png", ...colour } : null;
  }
  if (buf.toString("latin1", 0, 2) === "II" || buf.toString("latin1", 0, 2) === "MM") {
    const meta = await sharp(file)
      .metadata()
      .catch(() => null);
    if (meta?.format !== "tiff") return null;
    const colour = hdrTransfer(iccCicp(meta.icc));
    return colour ? { kind: "signal", container: "tiff", ...colour } : null;
  }
  // JPEG XL: a bare codestream (FF 0A) has no room for a gain map.
  if (buf.readUInt16BE(0) === 0xff0a) return { kind: "jxl" };
  if (buf.toString("latin1", 4, 8) === "JXL ")
    return (await jxlHasGainMap(file)) ? { kind: "gainMap", container: "jxl" } : { kind: "jxl" };
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const heif = readHeif(buf);
    if (!heif && more) return MORE;
    const primary = heif?.items.get(heif.primary);
    // Only AV1 decodes here; HEVC (HEIC) has no decoder for its HDR yet.
    if (!heif || primary?.type !== "av01") return null;
    const tmap = [...heif.items.values()].find((i) => i.type === "tmap");
    if (tmap && heif.refs.some((r) => r.type === "dimg" && r.from === tmap.id))
      return { kind: "gainMap", container: "avif" };
    const colour = hdrTransfer(nclx(primary));
    return colour ? { kind: "signal", container: "avif", ...colour } : null;
  }
  return null;
}

/** Walks the container's top-level boxes for 'jhgm'; they can sit after the image data. */
async function jxlHasGainMap(file: string): Promise<boolean> {
  const fd = await open(file, "r");
  try {
    const { size } = await fd.stat();
    const header = Buffer.alloc(16);
    let at = 0;
    while (at + 8 <= size) {
      await fd.read(header, 0, 16, at);
      let length = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "jhgm") return true;
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      else if (length === 0) return false;
      if (length < 8) return false;
      at += length;
    }
    return false;
  } finally {
    await fd.close();
  }
}
